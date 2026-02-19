import { describe, expect, it } from "vitest";
import { coerceBySchema } from "../../schema-coerce";

describe("Coercion Heuristic Handling", () => {
  describe("Primitive wrapper extraction", () => {
    it("should unwrap single-key object when schema expects string", () => {
      const input = { element: "hello" };
      const schema = { type: "string" };

      const result = coerceBySchema(input, schema);
      expect(result).toBe("hello");
    });

    it("should unwrap and coerce single-key object when schema expects number", () => {
      const input = { value: "42.5" };
      const schema = { type: "number" };

      const result = coerceBySchema(input, schema);
      expect(result).toBe(42.5);
    });

    it("should unwrap and coerce single-key object when schema expects boolean", () => {
      const input = { value: "true" };
      const schema = { type: "boolean" };

      const result = coerceBySchema(input, schema);
      expect(result).toBe(true);
    });

    it("should not unwrap when integer coercion fails", () => {
      const input = { value: "42.5" };
      const schema = { type: "integer" };

      const result = coerceBySchema(input, schema);
      expect(result).toEqual({ value: "42.5" });
    });

    it("should not unwrap when wrapped value is an object", () => {
      const input = { value: { nested: "x" } };
      const schema = { type: "string" };

      const result = coerceBySchema(input, schema);
      expect(result).toEqual({ value: { nested: "x" } });
    });

    it("should not unwrap multi-key object when schema expects string", () => {
      const input = { first: "hello", second: "world" };
      const schema = { type: "string" };

      const result = coerceBySchema(input, schema);
      expect(result).toEqual({ first: "hello", second: "world" });
    });
  });
});
