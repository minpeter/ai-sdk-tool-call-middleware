const JSON_EXPONENT_RE = /e([+-])(\d+)$/;
const MAX_NESTING_DEPTH = 256;
const MAX_SERIALIZED_VALUES = 100_000;
// Friendli's renderer canonicalizes schema numbers through Python-style JSON,
// while replayed arguments retain signed/unsigned 64-bit integers before
// falling back to float notation. These are separate byte-level contracts.
const PYTHON_SCIENTIFIC_NOTATION_THRESHOLD = 1e16;
const SCHEMA_LARGE_DECIMAL_THRESHOLD = 1e15;
const SIGNED_64_BIT_LOWER_BOUND = -(2 ** 63);
const UNSIGNED_64_BIT_LIMIT = 2 ** 64;

type Mapping = Record<string, unknown>;
type NativeJsonContext = "history" | "schema";
type SerializationFailure = "cycle" | "depth" | "size";
type SerializationTask =
  | {
      readonly kind: "value";
      readonly value: unknown;
      readonly depth: number;
    }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "leave"; readonly container: object };

class KExaone2SerializationError extends Error {
  readonly reason: SerializationFailure;

  constructor(reason: SerializationFailure) {
    const detail = {
      cycle: "contains a cycle",
      depth: `exceeds ${MAX_NESTING_DEPTH} nested containers`,
      size: `exceeds ${MAX_SERIALIZED_VALUES} values`,
    }[reason];
    super(`K-EXAONE native JSON ${detail}`);
    this.name = "KExaone2SerializationError";
    this.reason = reason;
  }
}

function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareByCodePoint(left: string, right: string): number {
  const leftCharacters = Array.from(left);
  const rightCharacters = Array.from(right);
  const length = Math.min(leftCharacters.length, rightCharacters.length);
  for (let index = 0; index < length; index += 1) {
    const leftCodePoint = leftCharacters[index]?.codePointAt(0) ?? -1;
    const rightCodePoint = rightCharacters[index]?.codePointAt(0) ?? -1;
    if (leftCodePoint !== rightCodePoint) {
      return leftCodePoint - rightCodePoint;
    }
  }
  return leftCharacters.length - rightCharacters.length;
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

function stringifyNativeNumber(
  value: number,
  context: NativeJsonContext
): string {
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

function pushContainerTasks(options: {
  readonly tasks: SerializationTask[];
  readonly value: Mapping | unknown[];
  readonly depth: number;
  readonly context: NativeJsonContext;
}): void {
  const { tasks, value, depth, context } = options;
  tasks.push({ kind: "leave", container: value });

  if (Array.isArray(value)) {
    tasks.push({ kind: "text", text: "]" });
    for (let index = value.length - 1; index >= 0; index -= 1) {
      tasks.push({ kind: "value", value: value[index], depth: depth + 1 });
      if (index > 0) {
        tasks.push({ kind: "text", text: ", " });
      }
    }
    tasks.push({ kind: "text", text: "[" });
    return;
  }

  const keys = Object.keys(value).filter((key) => {
    const property = value[key];
    return (
      property !== undefined &&
      typeof property !== "function" &&
      typeof property !== "symbol"
    );
  });
  if (context === "schema") {
    keys.sort(compareByCodePoint);
  }

  tasks.push({ kind: "text", text: "}" });
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const key = keys[index];
    if (key === undefined) {
      continue;
    }
    tasks.push({ kind: "value", value: value[key], depth: depth + 1 });
    tasks.push({ kind: "text", text: `${JSON.stringify(key)}: ` });
    if (index > 0) {
      tasks.push({ kind: "text", text: ", " });
    }
  }
  tasks.push({ kind: "text", text: "{" });
}

function stringifyPrimitive(
  value: unknown,
  context: NativeJsonContext
): string {
  return typeof value === "number"
    ? stringifyNativeNumber(value, context)
    : (JSON.stringify(value) ?? "null");
}

function stringifyWithContext(
  value: unknown,
  context: NativeJsonContext
): string {
  const activeContainers = new WeakSet<object>();
  const chunks: string[] = [];
  const tasks: SerializationTask[] = [{ kind: "value", value, depth: 0 }];
  let serializedValues = 0;

  while (tasks.length > 0) {
    const task = tasks.pop();
    if (task === undefined) {
      continue;
    }

    if (task.kind === "text") {
      chunks.push(task.text);
      continue;
    }
    if (task.kind === "leave") {
      activeContainers.delete(task.container);
      continue;
    }

    serializedValues += 1;
    if (serializedValues > MAX_SERIALIZED_VALUES) {
      throw new KExaone2SerializationError("size");
    }

    const { value: currentValue } = task;
    if (Array.isArray(currentValue) || isMapping(currentValue)) {
      if (task.depth > MAX_NESTING_DEPTH) {
        throw new KExaone2SerializationError("depth");
      }
      if (activeContainers.has(currentValue)) {
        throw new KExaone2SerializationError("cycle");
      }
      activeContainers.add(currentValue);
      pushContainerTasks({
        tasks,
        value: currentValue,
        depth: task.depth,
        context,
      });
      continue;
    }

    chunks.push(stringifyPrimitive(currentValue, context));
  }

  return chunks.join("");
}

export function stringifyKExaone2NativeJson(value: unknown): string {
  return stringifyWithContext(value, "history");
}

export function stringifyKExaone2NativeSchemaJson(value: unknown): string {
  return stringifyWithContext(value, "schema");
}
