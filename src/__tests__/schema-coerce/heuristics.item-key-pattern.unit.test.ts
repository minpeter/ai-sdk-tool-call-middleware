import { describe, expect, it } from "vitest";
import { coerceBySchema } from "../../schema-coerce";

describe("Coercion Heuristic Handling", () => {
  describe("Item key pattern handling", () => {
    it("should extract array from item key", () => {
      const input = {
        item: ["46.603354", "1.8883340"],
      };

      const schema = {
        type: "array",
        items: { type: "number" },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([46.603_354, 1.888_334]);
      const arr = result as any[];
      expect(arr.every((item: any) => typeof item === "number")).toBe(true);
    });

    it("should handle single item value", () => {
      const input = {
        item: "42",
      };

      const schema = {
        type: "array",
        items: { type: "number" },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([42]);
      expect(typeof result[0]).toBe("number");
    });

    it("should handle item with mixed types", () => {
      const input = {
        item: ["123", "hello", "45.67"],
      };

      const schema = {
        type: "array",
        items: { type: "number" },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([123, "hello", 45.67]); // "hello" stays as string
    });

    it("should prioritize 'item' key over numeric keys when both present", () => {
      // 'item' key takes precedence over numeric keys pattern
      const input = {
        item: "value",
        "0": "other",
      };

      const schema = {
        type: "array",
        items: { type: "string" },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual(["value"]);
    });

    it("should prioritize 'item' key over numeric keys when item is array", () => {
      const input = {
        item: ["a", "b"],
        "0": "x",
        "1": "y",
      };

      const schema = {
        type: "array",
        items: { type: "string" },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual(["a", "b"]);
    });
  });
});
