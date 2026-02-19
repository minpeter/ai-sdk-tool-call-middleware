import { describe, expect, it } from "vitest";
import { coerceBySchema } from "../../schema-coerce";

describe("Coercion Heuristic Handling", () => {
  describe("Edge cases and error handling", () => {
    it("should wrap empty object in array", () => {
      const input = {};

      const schema = {
        type: "array",
        items: { type: "string" },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({});
    });

    it("should handle null and undefined values", () => {
      const testCases = [null, undefined];

      const schema = {
        type: "array",
        items: { type: "string" },
      };

      for (const input of testCases) {
        const result = coerceBySchema(input, schema);
        expect(result).toEqual([input]); // null/undefined should be wrapped in array
      }
    });

    it("should handle primitive values for array schema", () => {
      const testCases = ["hello", 42, true];

      const schema = {
        type: "array",
        items: { type: "string" },
      };

      for (const input of testCases) {
        const result = coerceBySchema(input, schema);
        expect(Array.isArray(result)).toBe(true);
        expect(result).toHaveLength(1);
      }
    });

    it("should handle invalid JSON-like strings", () => {
      const input = "not valid json";

      const schema = {
        type: "array",
        items: { type: "string" },
      };

      const result = coerceBySchema(input, schema);
      expect(result).toEqual(["not valid json"]); // Should wrap in array
    });

    it("should handle circular references safely", () => {
      const input: any = { item: [] };
      input.item.push(input); // Create circular reference

      const schema = {
        type: "array",
        items: { type: "object" },
      };

      // Should not throw an error
      expect(() => coerceBySchema(input, schema)).not.toThrow();
    });
  });
});
