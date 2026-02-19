import { describe, expect, it } from "vitest";
import { coerceBySchema } from "../../schema-coerce";

describe("Coercion Heuristic Handling", () => {
  describe("Object property coercion", () => {
    it("should coerce additionalProperties values using schema", () => {
      const input = { a: "1", b: "2" };

      const schema = {
        type: "object",
        additionalProperties: { type: "number" },
      };

      const result = coerceBySchema(input, schema) as any;
      expect(result).toEqual({ a: 1, b: 2 });
      expect(typeof result.a).toBe("number");
      expect(typeof result.b).toBe("number");
    });

    it("should apply patternProperties before additionalProperties", () => {
      const input = { foo: "1", bar: "2" };

      const schema = {
        type: "object",
        patternProperties: {
          "^f": { type: "number" },
        },
        additionalProperties: { type: "string" },
      };

      const result = coerceBySchema(input, schema) as any;
      expect(result).toEqual({ foo: 1, bar: "2" });
      expect(typeof result.foo).toBe("number");
      expect(typeof result.bar).toBe("string");
    });

    it("should coerce values from stringified objects using additionalProperties", () => {
      const input = '{"a":"1","b":"2"}';

      const schema = {
        type: "object",
        additionalProperties: { type: "number" },
      };

      const result = coerceBySchema(input, schema) as any;
      expect(result).toEqual({ a: 1, b: 2 });
    });

    it("should apply both properties and patternProperties schemas sequentially when both match", () => {
      // When a key matches both properties and patternProperties,
      // both schemas are applied sequentially (properties first, then patternProperties)
      const input = { foo: "123" };

      const schema = {
        type: "object",
        properties: {
          foo: { type: "string" },
        },
        patternProperties: {
          "^f": { type: "number" },
        },
      };

      // "123" -> coerced as string (properties) -> coerced as number (patternProperties)
      const result = coerceBySchema(input, schema) as any;
      expect(result).toEqual({ foo: 123 });
      expect(typeof result.foo).toBe("number");
    });

    it("should handle conflicting properties and patternProperties schemas gracefully", () => {
      // When schemas conflict (one expects string, other expects number),
      // the final result depends on the order of application
      const input = { foo: "hello" };

      const schema = {
        type: "object",
        properties: {
          foo: { type: "string" },
        },
        patternProperties: {
          "^f": { type: "number" },
        },
      };

      // "hello" -> string (properties) -> can't coerce to number, stays as "hello"
      const result = coerceBySchema(input, schema) as any;
      expect(result).toEqual({ foo: "hello" });
      expect(typeof result.foo).toBe("string");
    });
  });
});
