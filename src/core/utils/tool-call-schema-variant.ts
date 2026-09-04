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
import { collectSchemaSelectionPropertyNames } from "./tool-call-schema-property-names";

type RxmlRecord = Readonly<Record<string, RxmlValue>>;
type MatchMode = "all" | "any" | "one";

const COMBINE_MATCH_RESULTS = {
  all: (values: readonly boolean[]) => values.every(Boolean),
  any: (values: readonly boolean[]) => values.some(Boolean),
  one: (values: readonly boolean[]) => values.filter(Boolean).length === 1,
} satisfies Record<MatchMode, (values: readonly boolean[]) => boolean>;

interface SchemaMatchRequest {
  readonly schema: ToolInputSchemaDefinition;
  readonly seen: Set<object>;
  readonly value: RxmlValue;
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
      readonly kind: "combine";
      readonly count: number;
      readonly mode: MatchMode;
    }
  | { readonly kind: "evaluate"; readonly request: SchemaMatchRequest };

interface ValuePair {
  readonly left: RxmlValue;
  readonly right: RxmlValue;
}

function isRxmlRecord(value: RxmlValue): value is RxmlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonTypeMatches(schemaType: string, value: RxmlValue): boolean {
  switch (schemaType) {
    case "object":
      return isRxmlRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function schemaTypeMatches(schema: ToolInputSchema, value: RxmlValue): boolean {
  if (typeof schema.type === "string") {
    return jsonTypeMatches(schema.type, value);
  }
  return (
    !Array.isArray(schema.type) ||
    schema.type.some((entry) => jsonTypeMatches(entry, value))
  );
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
  if (!(isRxmlRecord(left) && isRxmlRecord(right))) {
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

function jsonValuesEqual(left: RxmlValue, right: RxmlValue): boolean {
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

function directSchemaMatch(schema: ToolInputSchema, value: RxmlValue): boolean {
  if (!schemaTypeMatches(schema, value)) {
    return false;
  }
  if (Object.hasOwn(schema, "const") && !jsonValuesEqual(schema.const, value)) {
    return false;
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((entry) => jsonValuesEqual(entry, value))
  ) {
    return false;
  }
  return !(
    Array.isArray(schema.required) &&
    (!isRxmlRecord(value) ||
      schema.required.some((key) => !Object.hasOwn(value, key)))
  );
}

function propertyMatchRequests(
  schema: ToolInputSchema,
  value: RxmlRecord,
  seen: Set<object>
): SchemaMatchRequest[] | null {
  const requests: SchemaMatchRequest[] = [];
  for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
    if (!Object.hasOwn(value, key)) {
      continue;
    }
    if (propertySchema === false) {
      return null;
    }
    requests.push({
      schema: propertySchema,
      value: value[key],
      seen: new Set(seen),
    });
  }
  for (const key of collectPatternPropertyNames(schema, value)) {
    const propertySchema = getPatternPropertySchema(schema, key);
    if (propertySchema !== undefined) {
      requests.push({
        schema: propertySchema,
        value: value[key],
        seen: new Set(seen),
      });
    }
  }
  return requests;
}

function nestedMatchRequests(
  schema: ToolInputSchema,
  value: RxmlValue,
  seen: Set<object>
): MatchOperand[] | null {
  const operands: MatchOperand[] = [];
  if (isRxmlRecord(value)) {
    const requests = propertyMatchRequests(schema, value, seen);
    if (requests === null) {
      return null;
    }
    operands.push(...requests);
  }
  for (const [mode, variants] of [
    ["all", schema.allOf],
    ["any", schema.anyOf],
    ["one", schema.oneOf],
  ] satisfies readonly (readonly [
    MatchMode,
    readonly ToolInputSchemaDefinition[] | undefined,
  ])[]) {
    if (variants) {
      operands.push({
        mode,
        requests: variants.map((variant) => ({
          schema: variant,
          seen: new Set(seen),
          value,
        })),
      });
    }
  }
  return operands;
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
  const unwrapped = unwrapJsonSchema(request.schema);
  if (unwrapped === false) {
    return { kind: "result", value: false };
  }
  if (
    unwrapped === true ||
    typeof unwrapped !== "object" ||
    !isSchemaRecord(unwrapped) ||
    request.seen.has(unwrapped)
  ) {
    return { kind: "result", value: true };
  }
  if (!directSchemaMatch(unwrapped, request.value)) {
    return { kind: "result", value: false };
  }
  const nextSeen = new Set(request.seen);
  nextSeen.add(unwrapped);
  const operands = nestedMatchRequests(unwrapped, request.value, nextSeen);
  return operands === null
    ? { kind: "result", value: false }
    : { kind: "operands", value: operands };
}

function enqueueMatchOperands(
  work: MatchWork[],
  operands: readonly MatchOperand[]
): void {
  work.push({ kind: "combine", count: operands.length, mode: "all" });
  for (let index = operands.length - 1; index >= 0; index -= 1) {
    const operand = operands[index];
    if (operand === undefined) {
      continue;
    }
    if ("requests" in operand) {
      work.push({
        kind: "combine",
        count: operand.requests.length,
        mode: operand.mode,
      });
      for (let branch = operand.requests.length - 1; branch >= 0; branch -= 1) {
        const request = operand.requests[branch];
        if (request !== undefined) {
          work.push({ kind: "evaluate", request });
        }
      }
    } else {
      work.push({ kind: "evaluate", request: operand });
    }
  }
}

function schemaAcceptsValue(
  schema: ToolInputSchemaDefinition,
  value: RxmlValue,
  seen: Set<object>
): boolean {
  const results: boolean[] = [];
  const work: MatchWork[] = [
    { kind: "evaluate", request: { schema, seen, value } },
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

function schemaSelectionScore(
  schema: ToolInputSchemaDefinition,
  value: RxmlValue
): number {
  if (!isRxmlRecord(value)) {
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
