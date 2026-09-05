import type { JSONArray, JSONObject, JSONValue } from "@ai-sdk/provider";
import type { RxmlValue } from "../../rxml/builders/stringify";
import {
  isCycleSafeJsonValue,
  isSchemaRecord,
  type ToolInputSchema,
  type ToolInputSchemaDefinition,
} from "../../schema/tool-input-schema";
import {
  compileSafePatternPropertyRegex,
  getSchemaType,
  schemaIsUnconstrained,
} from "../../schema-coerce";
import {
  createCombinatorGroups,
  isSchemaValueRecord,
  runSchemaMatch,
  type SchemaMatchEvaluation,
  type SchemaMatchOperand,
  type SchemaMatchRequest,
  schemaValueMatchesConstAndEnum,
  schemaValueMatchesExplicitType,
  unwrapSchemaMatchRequest,
} from "../utils/tool-call-schema-match-engine";
import { unsafeDeniedPatternMayMatchKey } from "../utils/unsafe-pattern";

const MAX_ARGUMENT_SHAPE_DEPTH = 256;
type ArgumentValue = JSONValue | undefined;
type JsonContainer = JSONArray | JSONObject;
type PatternProperties = NonNullable<ToolInputSchema["patternProperties"]>;
interface MatchContext {
  readonly depth: number;
  readonly enforceValueKinds: boolean;
}
type HermesRequest = SchemaMatchRequest<MatchContext>;
interface CompiledPatternSchema {
  readonly pattern: string;
  readonly regex: RegExp | null;
  readonly schema: ToolInputSchemaDefinition;
}

const patternSchemaCache = new WeakMap<
  PatternProperties,
  CompiledPatternSchema[]
>();

function compiledPatterns(
  patternProperties: PatternProperties
): CompiledPatternSchema[] {
  const cached = patternSchemaCache.get(patternProperties);
  if (cached) {
    return cached;
  }
  const compiled = Object.entries(patternProperties).map(
    ([pattern, schema]) => ({
      pattern,
      regex: compileSafePatternPropertyRegex(pattern),
      schema,
    })
  );
  patternSchemaCache.set(patternProperties, compiled);
  return compiled;
}

function matchingPatternSchemas(
  patternProperties: PatternProperties | undefined,
  key: string
): ToolInputSchemaDefinition[] | null {
  if (!patternProperties) {
    return [];
  }
  const schemas: ToolInputSchemaDefinition[] = [];
  for (const { pattern, regex, schema } of compiledPatterns(
    patternProperties
  )) {
    if (regex?.test(key)) {
      if (schema === false) {
        return null;
      }
      schemas.push(schema);
    } else if (
      regex === null &&
      (schema === false || !schemaIsUnconstrained(schema)) &&
      unsafeDeniedPatternMayMatchKey(pattern, key)
    ) {
      return null;
    }
  }
  return schemas;
}

function isObjectSchema(schema: ToolInputSchema): boolean {
  return (
    getSchemaType(schema) === "object" ||
    schema.properties !== undefined ||
    schema.patternProperties !== undefined ||
    Array.isArray(schema.required) ||
    Object.hasOwn(schema, "additionalProperties")
  );
}

function isArraySchema(schema: ToolInputSchema): boolean {
  return (
    getSchemaType(schema) === "array" ||
    Array.isArray(schema.prefixItems) ||
    Array.isArray(schema.items)
  );
}

function valueKindMatches(schema: ToolInputSchema, value: RxmlValue): boolean {
  if (!schemaValueMatchesConstAndEnum(schema, value)) {
    return false;
  }
  if (schema.type !== undefined) {
    return schemaValueMatchesExplicitType(schema, value);
  }
  if (isObjectSchema(schema)) {
    return isSchemaValueRecord(value);
  }
  return !isArraySchema(schema) || Array.isArray(value);
}

function childRequest(
  request: HermesRequest,
  schema: ToolInputSchemaDefinition,
  value: RxmlValue
): HermesRequest {
  return {
    context: {
      depth: request.context.depth + 1,
      enforceValueKinds: request.context.enforceValueKinds,
    },
    schema,
    seen: new Set(request.seen),
    value,
  };
}

function objectOperands(
  value: Readonly<Record<string, RxmlValue>>,
  schema: ToolInputSchema,
  request: HermesRequest
): HermesRequest[] | null {
  if (
    schema.required?.some((key) => key.length > 0 && !Object.hasOwn(value, key))
  ) {
    return null;
  }
  const requests: HermesRequest[] = [];
  for (const [key, nestedValue] of Object.entries(value)) {
    const propertySchema = schema.properties?.[key];
    if (propertySchema === false) {
      return null;
    }
    const patterns = matchingPatternSchemas(schema.patternProperties, key);
    if (patterns === null) {
      return null;
    }
    const schemas = [
      ...(propertySchema === undefined ? [] : [propertySchema]),
      ...patterns,
    ];
    if (schemas.length === 0) {
      if (schema.additionalProperties === false) {
        return null;
      }
      if (
        typeof schema.additionalProperties === "object" &&
        isSchemaRecord(schema.additionalProperties)
      ) {
        schemas.push(schema.additionalProperties);
      }
    }
    for (const nestedSchema of schemas) {
      requests.push(childRequest(request, nestedSchema, nestedValue));
    }
  }
  return requests;
}

function arrayOperands(
  value: readonly RxmlValue[],
  schema: ToolInputSchema,
  request: HermesRequest
): HermesRequest[] | null {
  let tupleItems: readonly ToolInputSchemaDefinition[] | undefined;
  if (Array.isArray(schema.prefixItems)) {
    tupleItems = schema.prefixItems;
  } else if (Array.isArray(schema.items)) {
    tupleItems = schema.items;
  }
  const requests: HermesRequest[] = [];
  for (const [index, item] of value.entries()) {
    const itemSchema = tupleItems
      ? (tupleItems[index] ??
        (Array.isArray(schema.items) ? schema.additionalItems : schema.items))
      : schema.items;
    if (itemSchema === false) {
      return null;
    }
    if (itemSchema !== undefined && !Array.isArray(itemSchema)) {
      requests.push(childRequest(request, itemSchema, item));
    }
  }
  return requests;
}

function nestedOperands(
  schema: ToolInputSchema,
  request: HermesRequest
): SchemaMatchOperand<MatchContext>[] | null {
  const branchSeen = new Set(request.seen);
  if (typeof request.value === "object" && request.value !== null) {
    branchSeen.delete(request.value);
  }
  const branchContext = {
    depth: request.context.depth + 1,
    enforceValueKinds: true,
  };
  const operands: SchemaMatchOperand<MatchContext>[] = createCombinatorGroups(
    schema,
    request,
    branchContext,
    branchSeen
  );
  const explicitNull =
    request.value === null &&
    (schema.type === "null" ||
      (Array.isArray(schema.type) && schema.type.includes("null")));
  if (explicitNull) {
    return operands;
  }
  let nested: HermesRequest[] | null = [];
  if (isObjectSchema(schema)) {
    nested = isSchemaValueRecord(request.value)
      ? objectOperands(request.value, schema, request)
      : null;
  } else if (isArraySchema(schema)) {
    nested = Array.isArray(request.value)
      ? arrayOperands(request.value, schema, request)
      : null;
  }
  return nested === null ? null : [...operands, ...nested];
}

function evaluateHermesRequest(
  request: HermesRequest
): SchemaMatchEvaluation<MatchContext> {
  if (request.context.depth > MAX_ARGUMENT_SHAPE_DEPTH) {
    return { kind: "result", value: false };
  }
  const schema = unwrapSchemaMatchRequest(request);
  if (schema === false) {
    return { kind: "result", value: false };
  }
  if (schema === true || schema === undefined) {
    return { kind: "result", value: true };
  }
  if (
    request.context.enforceValueKinds &&
    !valueKindMatches(schema, request.value)
  ) {
    return { kind: "result", value: false };
  }
  if (typeof request.value === "object" && request.value !== null) {
    if (request.seen.has(request.value)) {
      return { kind: "result", value: true };
    }
    request.seen.add(request.value);
  }
  const operands = nestedOperands(schema, request);
  return operands === null
    ? { kind: "result", value: false }
    : { kind: "operands", value: operands };
}

export function argumentValueMatchesSchemaKeyShape(
  value: ArgumentValue,
  schema: ToolInputSchemaDefinition,
  seen = new Set<JsonContainer>(),
  enforceValueKinds = false,
  depth = 0
): boolean {
  if (!isCycleSafeJsonValue(value)) {
    return false;
  }
  return runSchemaMatch(
    {
      context: { depth, enforceValueKinds },
      schema,
      seen,
      value,
    },
    evaluateHermesRequest
  );
}
