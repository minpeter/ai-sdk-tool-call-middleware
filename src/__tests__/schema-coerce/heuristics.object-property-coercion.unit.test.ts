import {
  isJSONObject,
  type JSONObject,
  type JSONSchema7,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { coerceBySchema } from "../../schema-coerce";

const additionalNumberSchema: JSONSchema7 = {
  type: "object",
  additionalProperties: { type: "number" },
};
const fooPropertySchemas: JSONSchema7 = {
  type: "object",
  properties: { foo: { type: "string" } },
  patternProperties: { "^f": { type: "number" } },
};

function coerceObject(
  input: Parameters<typeof coerceBySchema>[0],
  schema: JSONSchema7
): JSONObject {
  const result = coerceBySchema(input, schema);
  if (!isJSONObject(result) || Array.isArray(result)) {
    throw new TypeError("Expected coerced object");
  }
  return result;
}

describe("Coercion Heuristic Handling", () => {
  describe("Object property coercion", () => {
    it("should coerce additionalProperties values using schema", () => {
      const input = { a: "1", b: "2" };
      const result = coerceObject(input, additionalNumberSchema);
      expect(result).toEqual({ a: 1, b: 2 });
      expect(typeof result.a).toBe("number");
      expect(typeof result.b).toBe("number");
    });

    it("should apply patternProperties before additionalProperties", () => {
      const input = { foo: "1", bar: "2" };
      const schema: JSONSchema7 = {
        type: "object",
        patternProperties: { "^f": { type: "number" } },
        additionalProperties: { type: "string" },
      };

      const result = coerceObject(input, schema);
      expect(result).toEqual({ foo: 1, bar: "2" });
      expect(typeof result.foo).toBe("number");
      expect(typeof result.bar).toBe("string");
    });

    it("should coerce values from stringified objects using additionalProperties", () => {
      const input = '{"a":"1","b":"2"}';
      const result = coerceObject(input, additionalNumberSchema);
      expect(result).toEqual({ a: 1, b: 2 });
    });

    it("should not mutate output prototypes from parsed __proto__ properties", () => {
      const input = JSON.parse('{"__proto__":{"polluted":true},"a":"1"}');
      const result = coerceObject(input, {
        type: "object",
        additionalProperties: true,
      });

      expect(Object.getPrototypeOf(result)).toBeNull();
      expect(
        Object.getOwnPropertyDescriptor(result, "__proto__")?.value
      ).toEqual({ polluted: true });
      expect("polluted" in result).toBe(false);
    });

    it("should apply both properties and patternProperties schemas sequentially when both match", () => {
      // When a key matches both properties and patternProperties,
      // both schemas are applied sequentially (properties first, then patternProperties)
      const input = { foo: "123" };

      // "123" -> coerced as string (properties) -> coerced as number (patternProperties)
      const result = coerceObject(input, fooPropertySchemas);
      expect(result).toEqual({ foo: 123 });
      expect(typeof result.foo).toBe("number");
    });

    it("should handle conflicting properties and patternProperties schemas gracefully", () => {
      // When schemas conflict (one expects string, other expects number),
      // the final result depends on the order of application
      const input = { foo: "hello" };

      // "hello" -> string (properties) -> can't coerce to number, stays as "hello"
      const result = coerceObject(input, fooPropertySchemas);
      expect(result).toEqual({ foo: "hello" });
      expect(typeof result.foo).toBe("string");
    });
  });
});
