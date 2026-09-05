import type { RxmlValue } from "../../rxml/builders/stringify";
import {
  isSchemaRecord,
  type ToolInputSchema,
  type ToolInputSchemaDefinition,
} from "../../schema/tool-input-schema";
import { unwrapJsonSchema } from "../../schema-coerce";
import {
  collectPatternPropertyNames,
  getPatternPropertySchema,
} from "./tool-call-pattern-properties";
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
} from "./tool-call-schema-match-engine";
import { collectSchemaSelectionPropertyNames } from "./tool-call-schema-property-names";

type VariantMatchRequest = SchemaMatchRequest<undefined>;

function directSchemaMatch(schema: ToolInputSchema, value: RxmlValue): boolean {
  if (
    !(
      schemaValueMatchesExplicitType(schema, value) &&
      schemaValueMatchesConstAndEnum(schema, value)
    )
  ) {
    return false;
  }
  return !(
    Array.isArray(schema.required) &&
    (!isSchemaValueRecord(value) ||
      schema.required.some((key) => !Object.hasOwn(value, key)))
  );
}

function propertyRequests(
  schema: ToolInputSchema,
  value: Readonly<Record<string, RxmlValue>>,
  seen: Set<object>
): VariantMatchRequest[] | null {
  const requests: VariantMatchRequest[] = [];
  for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
    if (!Object.hasOwn(value, key)) {
      continue;
    }
    if (propertySchema === false) {
      return null;
    }
    requests.push({
      context: undefined,
      schema: propertySchema,
      seen: new Set(seen),
      value: value[key],
    });
  }
  for (const key of Object.keys(value)) {
    const propertySchema = getPatternPropertySchema(schema, key);
    if (propertySchema !== undefined) {
      requests.push({
        context: undefined,
        schema: propertySchema,
        seen: new Set(seen),
        value: value[key],
      });
    }
  }
  return requests;
}

function evaluateVariantRequest(
  request: VariantMatchRequest
): SchemaMatchEvaluation<undefined> {
  const schema = unwrapSchemaMatchRequest(request);
  if (schema === false) {
    return { kind: "result", value: false };
  }
  if (
    schema === true ||
    schema === undefined ||
    !isSchemaRecord(schema) ||
    request.seen.has(schema)
  ) {
    return { kind: "result", value: true };
  }
  if (!directSchemaMatch(schema, request.value)) {
    return { kind: "result", value: false };
  }
  const seen = new Set(request.seen);
  seen.add(schema);
  const operands: SchemaMatchOperand<undefined>[] = createCombinatorGroups(
    schema,
    request,
    undefined,
    seen
  );
  if (isSchemaValueRecord(request.value)) {
    const nested = propertyRequests(schema, request.value, seen);
    if (nested === null) {
      return { kind: "result", value: false };
    }
    operands.push(...nested);
  }
  return { kind: "operands", value: operands };
}

function schemaAcceptsValue(
  schema: ToolInputSchemaDefinition,
  value: RxmlValue,
  seen: Set<object>
): boolean {
  return runSchemaMatch(
    { context: undefined, schema, seen, value },
    evaluateVariantRequest
  );
}

function schemaSelectionScore(
  schema: ToolInputSchemaDefinition,
  value: RxmlValue
): number {
  if (!isSchemaValueRecord(value)) {
    return 0;
  }
  const names = collectSchemaSelectionPropertyNames(schema);
  const unwrapped = unwrapJsonSchema(schema);
  if (typeof unwrapped === "object" && isSchemaRecord(unwrapped)) {
    for (const name of collectPatternPropertyNames(unwrapped, value)) {
      names.add(name);
    }
  }
  let score = 0;
  for (const name of names) {
    if (Object.hasOwn(value, name)) {
      score += 2;
    }
  }
  if (
    typeof unwrapped === "object" &&
    isSchemaRecord(unwrapped) &&
    unwrapped.additionalProperties === false
  ) {
    for (const key of Object.keys(value)) {
      if (!names.has(key)) {
        score -= 1;
      }
    }
  }
  return score;
}

export function selectSchemaVariant(
  variants: readonly ToolInputSchemaDefinition[] | undefined,
  value: RxmlValue,
  seen: Set<object>
): ToolInputSchemaDefinition | undefined {
  if (!variants) {
    return;
  }
  let bestVariant: ToolInputSchemaDefinition | undefined;
  let bestScore = 0;
  for (const variant of variants) {
    if (!schemaAcceptsValue(variant, value, new Set(seen))) {
      continue;
    }
    const score = schemaSelectionScore(variant, value);
    if (bestVariant === undefined || score > bestScore) {
      bestVariant = variant;
      bestScore = score;
    }
  }
  if (bestVariant !== undefined) {
    return bestVariant;
  }
  for (const variant of variants) {
    const score = schemaSelectionScore(variant, value);
    if (score > bestScore) {
      bestVariant = variant;
      bestScore = score;
    }
  }
  return bestVariant;
}
