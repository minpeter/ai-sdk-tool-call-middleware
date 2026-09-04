import type { JSONValue } from "@ai-sdk/provider";

interface RjsonObject {
  readonly [key: string]: Rjson;
}

type RjsonArray = Rjson[];

/** A value supported by the RJSON stringifier. */
export type Rjson = JSONValue | RjsonObject | RjsonArray | undefined;

/**
 * Convert an RJSON value to a JSON string with sorted object keys.
 *
 * Unlike `JSON.stringify`, `undefined` is serialized as `null`, including in
 * object properties. Object keys are sorted alphabetically for deterministic
 * output.
 *
 * @param value - The RJSON value to serialize
 * @returns The deterministic JSON representation
 *
 * @example
 * ```typescript
 * stringify({ z: 1, a: 2, m: 3 })
 * // Returns: '{"a":2,"m":3,"z":1}'
 *
 * stringify({ key: undefined })
 * // Returns: '{"key":null}'
 * ```
 */
export function stringify(value: Rjson): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return JSON.stringify(value);
  }

  if (value === undefined) {
    return "null";
  }

  if (typeof value !== "object") {
    return "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map(stringify).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  const pairs = keys.map(
    (key) => `${JSON.stringify(key)}:${stringify(value[key])}`
  );
  return `{${pairs.join(",")}}`;
}
