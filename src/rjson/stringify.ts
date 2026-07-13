// --- Stringify Function (Basic Implementation) ---
// Note: This is a basic, non-configurable stringifier, mainly for potential internal use or testing.
// It doesn't handle replacer/space arguments like JSON.stringify.

// Helper for stringifying object pairs
// :: any -> string -> ... -> string
function stringifyPair(
  obj: { [objKey: string]: unknown },
  key: string
): string {
  // Stringify key and value, then join with colon
  // Recursively calls stringify for the value
  return `${JSON.stringify(key)}:${stringify(obj[key])}`;
}

/**
 * Convert JavaScript value to JSON string with sorted object keys
 *
 * Similar to JSON.stringify but with consistent key ordering (sorted alphabetically).
 * Handles undefined values by converting them to null.
 *
 * @param obj - The value to convert to JSON string
 * @returns A JSON string representation
 *
 * @example
 * ```typescript
 * stringify({z: 1, a: 2, m: 3})
 * // Returns: '{"a":2,"m":3,"z":1}' (keys sorted)
 *
 * stringify({key: undefined})
 * // Returns: '{"key":null}' (undefined becomes null)
 * ```
 */
export function stringify(obj: unknown): string {
  const type = typeof obj;

  // Handle primitives directly using JSON.stringify (handles escaping etc.)
  if (
    type === "string" ||
    type === "number" ||
    type === "boolean" ||
    obj === null
  ) {
    return JSON.stringify(obj);
  }

  // Handle undefined (represented as null in this basic version, JSON.stringify omits in objects/returns undefined at top level)
  if (type === "undefined") {
    return "null";
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    // Recursively stringify each element and join with commas
    const elements = obj.map(stringify).join(",");
    return `[${elements}]`;
  }

  // Handle objects
  // Check if it's a non-null object (using constructor check is less robust than typeof + null check)
  if (type === "object") {
    // Already checked for null and Array above
    // Get keys, sort them for consistent output (optional, but good practice)
    const keys = Object.keys(obj as object);
    keys.sort();
    // Stringify each key-value pair and join with commas
    const pairs = keys
      .map((key) => stringifyPair(obj as { [objKey: string]: unknown }, key))
      .join(",");
    return `{${pairs}}`;
  }

  // Fallback for unsupported types (like functions, symbols) - represent as null
  return "null";
}
