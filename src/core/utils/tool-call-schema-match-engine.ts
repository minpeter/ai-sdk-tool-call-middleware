import type { JSONSchema7TypeName } from "json-schema";
import type { RxmlValue } from "../../rxml/builders/stringify";
import type {
  ToolInputSchema,
  ToolInputSchemaDefinition,
} from "../../schema/tool-input-schema";
import { unwrapJsonSchema } from "../../schema-coerce";
import { rxmlValuesEqual } from "./rxml-value-equality";

type SchemaMatchMode = "all" | "any" | "one";

export interface SchemaMatchRequest<Context> {
  readonly context: Context;
  readonly schema: ToolInputSchemaDefinition;
  readonly seen: Set<object>;
  readonly value: RxmlValue;
}

export interface SchemaMatchGroup<Context> {
  readonly mode: SchemaMatchMode;
  readonly requests: readonly SchemaMatchRequest<Context>[];
}

export type SchemaMatchOperand<Context> =
  | SchemaMatchGroup<Context>
  | SchemaMatchRequest<Context>;

export type SchemaMatchEvaluation<Context> =
  | {
      readonly kind: "operands";
      readonly value: readonly SchemaMatchOperand<Context>[];
    }
  | { readonly kind: "result"; readonly value: boolean };

type MatchWork<Context> =
  | {
      readonly count: number;
      readonly kind: "combine";
      readonly mode: SchemaMatchMode;
    }
  | {
      readonly kind: "evaluate";
      readonly request: SchemaMatchRequest<Context>;
    };

const combineResults = {
  all: (values: readonly boolean[]) => values.every(Boolean),
  any: (values: readonly boolean[]) => values.some(Boolean),
  one: (values: readonly boolean[]) => values.filter(Boolean).length === 1,
} satisfies Record<SchemaMatchMode, (values: readonly boolean[]) => boolean>;

export function isSchemaValueRecord(
  value: RxmlValue
): value is Readonly<Record<string, RxmlValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const typeMatchers = {
  array: Array.isArray,
  boolean: (value: RxmlValue) => typeof value === "boolean",
  integer: (value: RxmlValue) =>
    typeof value === "number" && Number.isInteger(value),
  null: (value: RxmlValue) => value === null,
  number: (value: RxmlValue) =>
    typeof value === "number" && Number.isFinite(value),
  object: isSchemaValueRecord,
  string: (value: RxmlValue) => typeof value === "string",
} satisfies Record<JSONSchema7TypeName, (value: RxmlValue) => boolean>;

export function schemaValueMatchesExplicitType(
  schema: ToolInputSchema,
  value: RxmlValue
): boolean {
  if (typeof schema.type === "string") {
    return typeMatchers[schema.type](value);
  }
  return (
    !Array.isArray(schema.type) ||
    schema.type.some((type) => typeMatchers[type](value))
  );
}

export function schemaValueMatchesConstAndEnum(
  schema: ToolInputSchema,
  value: RxmlValue
): boolean {
  if (Object.hasOwn(schema, "const") && !rxmlValuesEqual(schema.const, value)) {
    return false;
  }
  return !(
    Array.isArray(schema.enum) &&
    !schema.enum.some((entry) => rxmlValuesEqual(entry, value))
  );
}

export function createCombinatorGroups<Context>(
  schema: ToolInputSchema,
  request: SchemaMatchRequest<Context>,
  context: Context = request.context,
  seen: Set<object> = request.seen
): SchemaMatchGroup<Context>[] {
  const groups: SchemaMatchGroup<Context>[] = [];
  for (const [mode, variants] of [
    ["all", schema.allOf],
    ["any", schema.anyOf],
    ["one", schema.oneOf],
  ] satisfies readonly (readonly [
    SchemaMatchMode,
    readonly ToolInputSchemaDefinition[] | undefined,
  ])[]) {
    if (variants) {
      groups.push({
        mode,
        requests: variants.map((variant) => ({
          context,
          schema: variant,
          seen: new Set(seen),
          value: request.value,
        })),
      });
    }
  }
  return groups;
}

export function unwrapSchemaMatchRequest<Context>(
  request: SchemaMatchRequest<Context>
): ToolInputSchema | boolean | undefined {
  return unwrapJsonSchema(request.schema);
}

function enqueueOperands<Context>(
  work: MatchWork<Context>[],
  operands: readonly SchemaMatchOperand<Context>[]
): void {
  work.push({ count: operands.length, kind: "combine", mode: "all" });
  for (const operand of operands.slice().reverse()) {
    if ("requests" in operand) {
      work.push({
        count: operand.requests.length,
        kind: "combine",
        mode: operand.mode,
      });
      for (const branch of operand.requests.slice().reverse()) {
        work.push({ kind: "evaluate", request: branch });
      }
    } else {
      work.push({ kind: "evaluate", request: operand });
    }
  }
}

export function runSchemaMatch<Context>(
  initial: SchemaMatchRequest<Context>,
  evaluate: (
    request: SchemaMatchRequest<Context>
  ) => SchemaMatchEvaluation<Context>
): boolean {
  const results: boolean[] = [];
  const work: MatchWork<Context>[] = [{ kind: "evaluate", request: initial }];
  while (work.length > 0) {
    for (const item of work.splice(-1, 1)) {
      if (item.kind === "combine") {
        const values = results.splice(results.length - item.count, item.count);
        results.push(combineResults[item.mode](values));
        continue;
      }
      const evaluation = evaluate(item.request);
      if (evaluation.kind === "result") {
        results.push(evaluation.value);
      } else {
        enqueueOperands(work, evaluation.value);
      }
    }
  }
  return results[0] === true;
}
