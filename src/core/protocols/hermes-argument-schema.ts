import type { JSONValue } from "@ai-sdk/provider";
import {
  isSchemaRecord,
  type ToolInputSchema,
  type ToolInputSchemaCandidate,
  type ToolInputSchemaDefinition,
} from "../../schema/tool-input-schema";
import {
  compileSafePatternPropertyRegex,
  getSchemaType,
  schemaIsUnconstrained,
  unwrapJsonSchema,
} from "../../schema-coerce";
import { unsafeDeniedPatternMayMatchKey } from "../utils/unsafe-pattern";

const MAX_ARGUMENT_SHAPE_DEPTH = 256;

type ArgumentValue = JSONValue | object | undefined;
type ArgumentRecord = Readonly<Record<string, ArgumentValue>>;
type MatchMode = "all" | "any" | "one";

const COMBINE_MATCH_RESULTS = {
  all: (values: readonly boolean[]) => values.every(Boolean),
  any: (values: readonly boolean[]) => values.some(Boolean),
  one: (values: readonly boolean[]) => values.filter(Boolean).length === 1,
} satisfies Record<MatchMode, (values: readonly boolean[]) => boolean>;
type PatternProperties = NonNullable<ToolInputSchema["patternProperties"]>;

interface PatternSchemaMatches {
  readonly schemas: ToolInputSchemaDefinition[];
  readonly unsafeDeniedPatterns: string[];
}

interface CompiledPatternSchema {
  readonly pattern: string;
  readonly regex: RegExp | null;
  readonly schema: ToolInputSchemaDefinition;
}

interface SchemaMatchRequest {
  readonly depth: number;
  readonly enforceValueKinds: boolean;
  readonly schema: ToolInputSchemaCandidate;
  readonly seen: Set<object>;
  readonly value: ArgumentValue;
}

interface MatchGroup {
  readonly mode: MatchMode;
  readonly requests: readonly SchemaMatchRequest[];
}

type MatchOperand = MatchGroup | SchemaMatchRequest;
type MatchEvaluation =
  | { readonly kind: "operands"; readonly value: readonly MatchOperand[] }
  | { readonly kind: "result"; readonly value: boolean };
type MatchWork =
  | {
      readonly count: number;
      readonly kind: "combine";
      readonly mode: MatchMode;
    }
  | { readonly kind: "evaluate"; readonly request: SchemaMatchRequest };

interface ValuePair {
  readonly left: ArgumentValue;
  readonly right: ArgumentValue;
}

const patternSchemaCache = new WeakMap<
  PatternProperties,
  CompiledPatternSchema[]
>();

function isArgumentRecord(value: ArgumentValue): value is ArgumentRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getCompiledPatternSchemas(
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

function getPatternSchemaMatches(
  patternProperties: PatternProperties | undefined,
  key: string
): PatternSchemaMatches {
  if (!patternProperties) {
    return { schemas: [], unsafeDeniedPatterns: [] };
  }
  const schemas: ToolInputSchemaDefinition[] = [];
  const unsafeDeniedPatterns: string[] = [];
  for (const { pattern, regex, schema } of getCompiledPatternSchemas(
    patternProperties
  )) {
    if (!regex) {
      if (schema === false || !schemaIsUnconstrained(schema)) {
        unsafeDeniedPatterns.push(pattern);
      }
    } else if (regex.test(key)) {
      schemas.push(schema);
    }
  }
  return { schemas, unsafeDeniedPatterns };
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

function valueMatchesSchemaType(
  value: ArgumentValue,
  schemaType: string
): boolean {
  switch (schemaType) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "null":
      return value === null;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return isArgumentRecord(value);
    case "string":
      return typeof value === "string";
    default:
      return true;
  }
}

function valuePairChildren(pair: ValuePair): ValuePair[] | null {
  const { left, right } = pair;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) {
      return null;
    }
    return left.map((leftItem, index) => ({
      left: leftItem,
      right: right[index],
    }));
  }
  if (Array.isArray(right)) {
    return null;
  }
  if (!(isArgumentRecord(left) && isArgumentRecord(right))) {
    return null;
  }
  const leftKeys = Object.keys(left);
  if (
    leftKeys.length !== Object.keys(right).length ||
    leftKeys.some((key) => !Object.hasOwn(right, key))
  ) {
    return null;
  }
  return leftKeys.map((key) => ({ left: left[key], right: right[key] }));
}

function jsonValuesEqual(left: ArgumentValue, right: ArgumentValue): boolean {
  const compared = new WeakMap<object, WeakSet<object>>();
  const pairs: ValuePair[] = [{ left, right }];
  while (pairs.length > 0) {
    const pair = pairs.pop();
    if (pair === undefined || Object.is(pair.left, pair.right)) {
      continue;
    }
    if (
      pair.left === null ||
      pair.right === null ||
      typeof pair.left !== "object" ||
      typeof pair.right !== "object"
    ) {
      return false;
    }
    const previousRights = compared.get(pair.left);
    if (previousRights?.has(pair.right)) {
      continue;
    }
    const children = valuePairChildren(pair);
    if (children === null) {
      return false;
    }
    const rights = previousRights ?? new WeakSet<object>();
    rights.add(pair.right);
    compared.set(pair.left, rights);
    pairs.push(...children);
  }
  return true;
}

function valueMatchesSchemaKind(
  value: ArgumentValue,
  schema: ToolInputSchema
): boolean {
  if (Object.hasOwn(schema, "const") && !jsonValuesEqual(value, schema.const)) {
    return false;
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((allowed) => jsonValuesEqual(value, allowed))
  ) {
    return false;
  }
  let schemaTypes: readonly string[] = [];
  if (typeof schema.type === "string") {
    schemaTypes = [schema.type];
  } else if (Array.isArray(schema.type)) {
    schemaTypes = schema.type;
  }
  if (schemaTypes.length > 0) {
    return schemaTypes.some((schemaType) =>
      valueMatchesSchemaType(value, schemaType)
    );
  }
  return !(
    (isObjectSchema(schema) && !isArgumentRecord(value)) ||
    (isArraySchema(schema) && !Array.isArray(value))
  );
}

function objectMatchOperands(
  value: ArgumentRecord,
  schema: ToolInputSchema,
  request: SchemaMatchRequest
): MatchOperand[] | null {
  if (
    schema.required?.some((key) =>
      typeof key === "string" && key.length > 0
        ? !Object.hasOwn(value, key)
        : false
    )
  ) {
    return null;
  }
  const operands: MatchOperand[] = [];
  for (const [key, nestedValue] of Object.entries(value)) {
    const propertySchema = schema.properties?.[key];
    const matches = getPatternSchemaMatches(schema.patternProperties, key);
    if (
      propertySchema === false ||
      matches.schemas.includes(false) ||
      matches.unsafeDeniedPatterns.some((pattern) =>
        unsafeDeniedPatternMayMatchKey(pattern, key)
      )
    ) {
      return null;
    }
    const schemas = [
      ...(propertySchema === undefined ? [] : [propertySchema]),
      ...matches.schemas.filter((candidate) => candidate !== false),
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
      operands.push({
        depth: request.depth + 1,
        enforceValueKinds: request.enforceValueKinds,
        schema: nestedSchema,
        seen: new Set(request.seen),
        value: nestedValue,
      });
    }
  }
  return operands;
}

function arrayMatchOperands(
  value: readonly ArgumentValue[],
  schema: ToolInputSchema,
  request: SchemaMatchRequest
): MatchOperand[] | null {
  let tupleItems: readonly ToolInputSchemaDefinition[] | undefined;
  if (Array.isArray(schema.prefixItems)) {
    tupleItems = schema.prefixItems;
  } else if (Array.isArray(schema.items)) {
    tupleItems = schema.items;
  }
  const operands: MatchOperand[] = [];
  for (const [index, item] of value.entries()) {
    const itemSchema = tupleItems
      ? (tupleItems[index] ??
        (Array.isArray(schema.items) ? schema.additionalItems : schema.items))
      : schema.items;
    if (itemSchema === false) {
      return null;
    }
    if (itemSchema !== undefined && !Array.isArray(itemSchema)) {
      operands.push({
        depth: request.depth + 1,
        enforceValueKinds: request.enforceValueKinds,
        schema: itemSchema,
        seen: new Set(request.seen),
        value: item,
      });
    }
  }
  return operands;
}

function combinatorOperands(
  schema: ToolInputSchema,
  request: SchemaMatchRequest
): MatchGroup[] {
  const operands: MatchGroup[] = [];
  for (const [mode, variants] of [
    ["all", schema.allOf],
    ["any", schema.anyOf],
    ["one", schema.oneOf],
  ] satisfies readonly (readonly [
    MatchMode,
    readonly ToolInputSchemaDefinition[] | undefined,
  ])[]) {
    if (!variants) {
      continue;
    }
    const branchSeen = new Set(request.seen);
    if (typeof request.value === "object" && request.value !== null) {
      branchSeen.delete(request.value);
    }
    operands.push({
      mode,
      requests: variants.map((variant) => ({
        depth: request.depth + 1,
        enforceValueKinds: true,
        schema: variant,
        seen: new Set(branchSeen),
        value: request.value,
      })),
    });
  }
  return operands;
}

function matchOperands(
  schema: ToolInputSchema,
  request: SchemaMatchRequest
): MatchOperand[] | null {
  const operands: MatchOperand[] = combinatorOperands(schema, request);
  const explicitNull =
    request.value === null &&
    (schema.type === "null" ||
      (Array.isArray(schema.type) && schema.type.includes("null")));
  if (explicitNull) {
    return operands;
  }
  if (isObjectSchema(schema)) {
    if (!isArgumentRecord(request.value)) {
      return null;
    }
    const nested = objectMatchOperands(request.value, schema, request);
    return nested === null ? null : [...operands, ...nested];
  }
  if (!isArraySchema(schema)) {
    return operands;
  }
  if (!Array.isArray(request.value)) {
    return null;
  }
  const nested = arrayMatchOperands(request.value, schema, request);
  return nested === null ? null : [...operands, ...nested];
}

function combineMatchResults(
  mode: MatchMode,
  results: boolean[],
  count: number
): void {
  const values = results.splice(results.length - count, count);
  results.push(COMBINE_MATCH_RESULTS[mode](values));
}

function evaluateSchemaRequest(request: SchemaMatchRequest): MatchEvaluation {
  if (request.depth > MAX_ARGUMENT_SHAPE_DEPTH) {
    return { kind: "result", value: false };
  }
  const unwrapped = unwrapJsonSchema(request.schema);
  if (unwrapped === false) {
    return { kind: "result", value: false };
  }
  if (
    unwrapped === true ||
    typeof unwrapped !== "object" ||
    !isSchemaRecord(unwrapped)
  ) {
    return { kind: "result", value: true };
  }
  if (
    request.enforceValueKinds &&
    !valueMatchesSchemaKind(request.value, unwrapped)
  ) {
    return { kind: "result", value: false };
  }
  if (typeof request.value === "object" && request.value !== null) {
    if (request.seen.has(request.value)) {
      return { kind: "result", value: true };
    }
    request.seen.add(request.value);
  }
  const operands = matchOperands(unwrapped, request);
  return operands === null
    ? { kind: "result", value: false }
    : { kind: "operands", value: operands };
}

function enqueueMatchOperands(
  work: MatchWork[],
  operands: readonly MatchOperand[]
): void {
  work.push({ count: operands.length, kind: "combine", mode: "all" });
  for (let index = operands.length - 1; index >= 0; index -= 1) {
    const operand = operands[index];
    if (operand === undefined) {
      continue;
    }
    if ("requests" in operand) {
      work.push({
        count: operand.requests.length,
        kind: "combine",
        mode: operand.mode,
      });
      for (let branch = operand.requests.length - 1; branch >= 0; branch -= 1) {
        const branchRequest = operand.requests[branch];
        if (branchRequest !== undefined) {
          work.push({ kind: "evaluate", request: branchRequest });
        }
      }
    } else {
      work.push({ kind: "evaluate", request: operand });
    }
  }
}

export function argumentValueMatchesSchemaKeyShape(
  value: ArgumentValue,
  schema: ToolInputSchemaCandidate,
  seen = new Set<object>(),
  enforceValueKinds = false,
  depth = 0
): boolean {
  const results: boolean[] = [];
  const work: MatchWork[] = [
    {
      kind: "evaluate",
      request: { depth, enforceValueKinds, schema, seen, value },
    },
  ];
  while (work.length > 0) {
    const item = work.pop();
    if (item === undefined) {
      continue;
    }
    if (item.kind === "combine") {
      combineMatchResults(item.mode, results, item.count);
      continue;
    }
    const evaluation = evaluateSchemaRequest(item.request);
    if (evaluation.kind === "result") {
      results.push(evaluation.value);
    } else {
      enqueueMatchOperands(work, evaluation.value);
    }
  }
  return results.pop() ?? false;
}
