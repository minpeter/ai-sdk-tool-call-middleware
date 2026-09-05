import type { JSONValue } from "@ai-sdk/provider";
import { decodeKExaone2HistoryKey } from "./k-exaone-2-lossless-json";
import { KExaone2HistoryNumber } from "./k-exaone-2-lossless-json-tokens";
import {
  K_EXAONE_2_MAX_NESTING_DEPTH,
  K_EXAONE_2_MAX_SERIALIZATION_WORK_ITEMS,
  KExaone2SerializationError,
} from "./k-exaone-2-serialization-error";

const JSON_EXPONENT_RE = /e([+-])(\d+)$/;
const HISTORY_INTEGER_RE = /^-?(?:0|[1-9]\d*)$/;
const MAX_UNSIGNED_64_BIT_INTEGER = BigInt("18446744073709551615");
const MIN_SIGNED_64_BIT_INTEGER = BigInt("-9223372036854775808");
// Friendli's renderer canonicalizes schema numbers through Python-style JSON;
// replayed arguments retain 64-bit integers before falling back to float notation.
const PYTHON_SCIENTIFIC_NOTATION_THRESHOLD = 1e16;
const SCHEMA_LARGE_DECIMAL_THRESHOLD = 1e15;
const SIGNED_64_BIT_LOWER_BOUND = -(2 ** 63);
const UNSIGNED_64_BIT_LIMIT = 2 ** 64;

type JsonContext = "history" | "schema";
export type KExaone2Value =
  | null
  | string
  | number
  | boolean
  | KExaone2HistoryNumber
  | readonly KExaone2Value[]
  | { readonly [key: string]: KExaone2Value | undefined };
interface KExaone2Object {
  readonly [key: string]: KExaone2Value | undefined;
}
type SerializationTask =
  | {
      readonly kind: "value";
      readonly value: KExaone2Value | undefined;
      readonly depth: number;
    }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "leave"; readonly container: object };

function isKExaone2Array(
  value: KExaone2Value | undefined
): value is readonly KExaone2Value[] {
  return Array.isArray(value);
}

function isMapping(value: KExaone2Value | undefined): value is KExaone2Object {
  return typeof value === "object" && value !== null && !isKExaone2Array(value);
}

function compareByCodePoint(left: string, right: string): number {
  const leftCodePoints = Array.from(left, (character) =>
    Number(character.codePointAt(0))
  );
  const rightCodePoints = Array.from(right, (character) =>
    Number(character.codePointAt(0))
  );
  const length = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference =
      Number(leftCodePoints[index]) - Number(rightCodePoints[index]);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftCodePoints.length - rightCodePoints.length;
}

function stringifyPythonExponent(value: number): string {
  return value
    .toExponential()
    .replace(
      JSON_EXPONENT_RE,
      (_match, sign: string, exponent: string) =>
        `e${sign}${exponent.padStart(2, "0")}`
    );
}

function stringifyNativeNumber(value: number, context: JsonContext): string {
  if (value !== 0 && Math.abs(value) < 0.0001 && Number.isFinite(value)) {
    return stringifyPythonExponent(value);
  }

  const serialized = JSON.stringify(value);
  const absoluteValue = Math.abs(value);
  if (
    context === "schema" &&
    Number.isInteger(value) &&
    absoluteValue >= SCHEMA_LARGE_DECIMAL_THRESHOLD &&
    serialized.endsWith("0")
  ) {
    return absoluteValue < PYTHON_SCIENTIFIC_NOTATION_THRESHOLD
      ? `${serialized}.0`
      : stringifyPythonExponent(value);
  }
  if (
    context === "history" &&
    Number.isInteger(value) &&
    (value <= SIGNED_64_BIT_LOWER_BOUND || value >= UNSIGNED_64_BIT_LIMIT)
  ) {
    return stringifyPythonExponent(value);
  }
  return serialized;
}

function stringifyHistoryFloat(value: number): string {
  if (Object.is(value, -0)) {
    return "-0.0";
  }
  const absoluteValue = Math.abs(value);
  if (
    value !== 0 &&
    (absoluteValue < 0.0001 ||
      absoluteValue >= PYTHON_SCIENTIFIC_NOTATION_THRESHOLD)
  ) {
    return stringifyPythonExponent(value);
  }
  const serialized = JSON.stringify(value);
  return Number.isInteger(value) ? `${serialized}.0` : serialized;
}

function stringifyLosslessHistoryNumber(value: KExaone2HistoryNumber): string {
  if (HISTORY_INTEGER_RE.test(value.raw)) {
    const integer = BigInt(value.raw);
    if (
      integer >= MIN_SIGNED_64_BIT_INTEGER &&
      integer <= MAX_UNSIGNED_64_BIT_INTEGER
    ) {
      return integer.toString();
    }
  }
  return stringifyHistoryFloat(Number(value.raw));
}

interface ContainerTaskOptions {
  readonly context: JsonContext;
  readonly depth: number;
  readonly remainingValues: number;
  readonly tasks: SerializationTask[];
  readonly value: KExaone2Object | readonly KExaone2Value[];
}

function pushArrayTasks(
  options: ContainerTaskOptions & { readonly value: readonly KExaone2Value[] }
): number {
  const { tasks, value, depth, remainingValues } = options;
  const { length } = value;
  if (length > remainingValues) {
    throw new KExaone2SerializationError("size");
  }
  const values: Array<KExaone2Value | undefined> = [];
  for (let index = 0; index < length; index += 1) {
    values.push(value[index]);
  }
  tasks.push({ kind: "text", text: "]" });
  for (let index = length - 1; index >= 0; index -= 1) {
    tasks.push({ kind: "value", value: values[index], depth: depth + 1 });
    if (index > 0) {
      tasks.push({ kind: "text", text: ", " });
    }
  }
  tasks.push({ kind: "text", text: "[" });
  return length;
}

function pushObjectTasks(
  options: ContainerTaskOptions & { readonly value: KExaone2Object }
): number {
  const { tasks, value, depth, context, remainingValues } = options;
  const objectKeys = Object.keys(value);
  if (objectKeys.length > remainingValues) {
    throw new KExaone2SerializationError("size");
  }
  const entries: Array<readonly [string, KExaone2Value]> = [];
  for (const key of objectKeys) {
    const property = value[key];
    if (
      property !== undefined &&
      typeof property !== "function" &&
      typeof property !== "symbol"
    ) {
      const outputKey =
        context === "history" ? decodeKExaone2HistoryKey(key) : key;
      entries.push([outputKey, property]);
    }
  }
  if (context === "schema") {
    entries.sort(([left], [right]) => compareByCodePoint(left, right));
  }

  tasks.push({ kind: "text", text: "}" });
  entries.reverse();
  for (const [index, [key, property]] of entries.entries()) {
    tasks.push({ kind: "value", value: property, depth: depth + 1 });
    tasks.push({ kind: "text", text: `${JSON.stringify(key)}: ` });
    if (index < entries.length - 1) {
      tasks.push({ kind: "text", text: ", " });
    }
  }
  tasks.push({ kind: "text", text: "{" });
  return objectKeys.length;
}

function pushContainerTasks(options: ContainerTaskOptions): number {
  const { tasks, value } = options;
  tasks.push({ kind: "leave", container: value });
  return isKExaone2Array(value)
    ? pushArrayTasks({ ...options, value })
    : pushObjectTasks({ ...options, value });
}

function stringifyValue(value: KExaone2Value | undefined, mode: JsonContext) {
  return typeof value === "number"
    ? stringifyNativeNumber(value, mode)
    : (JSON.stringify(value) ?? "null");
}

function stringifyWithContext(
  value: KExaone2Value,
  context: JsonContext
): string {
  const activeContainers = new WeakSet<object>();
  const chunks: string[] = [];
  const tasks: SerializationTask[] = [{ kind: "value", value, depth: 0 }];
  let scheduledWorkItems = 1;

  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === "text") {
      chunks.push(task.text);
      continue;
    }
    if (task.kind === "leave") {
      activeContainers.delete(task.container);
      continue;
    }

    const { value: currentValue } = task;
    if (
      context === "history" &&
      currentValue !== undefined &&
      currentValue instanceof KExaone2HistoryNumber
    ) {
      chunks.push(stringifyLosslessHistoryNumber(currentValue));
      continue;
    }
    if (isKExaone2Array(currentValue) || isMapping(currentValue)) {
      if (task.depth >= K_EXAONE_2_MAX_NESTING_DEPTH) {
        throw new KExaone2SerializationError("depth");
      }
      if (activeContainers.has(currentValue)) {
        throw new KExaone2SerializationError("cycle");
      }
      activeContainers.add(currentValue);
      const childCount = pushContainerTasks({
        tasks,
        value: currentValue,
        depth: task.depth,
        context,
        remainingValues:
          K_EXAONE_2_MAX_SERIALIZATION_WORK_ITEMS - scheduledWorkItems,
      });
      scheduledWorkItems += childCount;
      continue;
    }

    chunks.push(stringifyValue(currentValue, context));
  }

  return chunks.join("");
}

export function stringifyKExaone2NativeJson(value: KExaone2Value): string {
  return stringifyWithContext(value, "history");
}

export function stringifyKExaone2CompactJson(value: KExaone2Value): string {
  return stringifyKExaone2NativeJson(value).replace(
    /("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)|\s+/g,
    "$1"
  );
}

export function stringifyKExaone2NativeSchemaJson(value: JSONValue): string {
  return stringifyWithContext(value, "schema");
}
