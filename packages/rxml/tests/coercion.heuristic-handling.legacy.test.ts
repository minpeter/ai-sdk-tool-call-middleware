import { describe, expect, it } from "vitest";

import { coerceBySchema } from "../src";

describe("Coercion Heuristic Handling", () => {
  describe("Single key array extraction", () => {
    it("should extract array from single key object", () => {
      const input = {
        number: ["3", "5", "7"],
      };

      const schema = {
        type: "array",
        items: { type: "number" },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([3, 5, 7]);
      const arr = result as any[];
      expect(arr.every((item: any) => typeof item === "number")).toBe(true);
    });

    it("should extract string array from single key object", () => {
      const input = {
        color: ["red", "green", "blue"],
      };

      const schema = {
        type: "array",
        items: { type: "string" },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual(["red", "green", "blue"]);
      const arr = result as any[];
      expect(arr.every((item: any) => typeof item === "string")).toBe(true);
    });

    it("should handle mixed type single key extraction", () => {
      const input = {
        value: ["123", "hello", "45.67", "true"],
      };

      const schema = {
        type: "array",
        items: { type: "string" },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual(["123", "hello", "45.67", "true"]);
    });

    it("should NOT extract from multiple key objects", () => {
      const input = {
        number: ["3", "5"],
        color: ["red", "blue"],
      };

      const schema = {
        type: "array",
        items: { type: "string" },
      };

      // Should not extract when there are multiple keys
      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual(input); // Should return original
    });
  });

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
  });

  describe("Numeric key handling", () => {
    it("should convert numeric keys to array", () => {
      const input = {
        "0": "first",
        "1": "second",
        "2": "third",
      };

      const schema = {
        type: "array",
        items: { type: "string" },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual(["first", "second", "third"]);
    });

    it("should handle numeric keys with number coercion", () => {
      const input = {
        "0": "10.5",
        "1": "20.3",
        "2": "15.8",
      };

      const schema = {
        type: "array",
        items: { type: "number" },
      };

      const result = coerceBySchema(input, schema) as any;
      expect(result).toEqual([10.5, 20.3, 15.8]);
      const arr = result as any[];
      expect(arr.every((item: any) => typeof item === "number")).toBe(true);
    });

    it("should handle non-consecutive numeric keys", () => {
      const input = {
        "0": "first",
        "2": "third",
        "5": "sixth",
      };

      const schema = {
        type: "array",
        items: { type: "string" },
      };

      // Non-consecutive keys should still be converted but maintain order
      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual(["first", "third", "sixth"]);
    });

    it("should handle mixed key types (should not convert)", () => {
      const input = {
        "0": "zero",
        name: "test",
      };

      const schema = {
        type: "array",
        items: { type: "string" },
      };

      // Mixed keys should not be converted
      const result = coerceBySchema(input, schema);
      expect(result).toEqual(input); // Should return original
    });
  });

  describe("Tuple handling with prefixItems", () => {
    it("should handle tuple with prefixItems", () => {
      const input = {
        item: ["10.5", "hello", "true"],
      };

      const schema = {
        type: "array",
        prefixItems: [
          { type: "number" },
          { type: "string" },
          { type: "boolean" },
        ],
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([10.5, "hello", true]);
      expect(typeof result[0]).toBe("number");
      expect(typeof result[1]).toBe("string");
      expect(typeof result[2]).toBe("boolean");
    });

    it("should handle numeric keys with prefixItems", () => {
      const input = {
        "0": "123",
        "1": "hello",
        "2": "45.67",
      };

      const schema = {
        type: "array",
        prefixItems: [
          { type: "number" },
          { type: "string" },
          { type: "number" },
        ],
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([123, "hello", 45.67]);
      expect(typeof result[0]).toBe("number");
      expect(typeof result[1]).toBe("string");
      expect(typeof result[2]).toBe("number");
    });

    it("should fall back to items schema when prefixItems length mismatch", () => {
      const input = {
        item: ["10", "20", "30", "40"], // 4 items but only 2 prefixItems
      };

      const schema = {
        type: "array",
        prefixItems: [{ type: "number" }, { type: "number" }],
        items: { type: "string" }, // fallback for extra items
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual(["10", "20", "30", "40"]); // All converted as strings due to fallback
      expect(result.every((item: any) => typeof item === "string")).toBe(true);
    });
  });

  describe("Complex nested scenarios", () => {
    it("should handle nested object with array extraction", () => {
      const input = {
        coordinates: {
          item: ["46.603354", "1.8883340"],
        },
        name: "test location",
      };

      const schema = {
        type: "object",
        properties: {
          coordinates: {
            type: "array",
            items: { type: "number" },
          },
          name: { type: "string" },
        },
      };

      const result = coerceBySchema(input, schema) as any;
      expect(result).toEqual({
        coordinates: [46.603_354, 1.888_334],
        name: "test location",
      });
      const obj = result as any;
      expect(
        (obj.coordinates as any[]).every(
          (item: any) => typeof item === "number"
        )
      ).toBe(true);
    });

    it("should handle array of objects with heuristic extraction", () => {
      const input = [{ item: ["1", "2"] }, { item: ["3", "4"] }];

      const schema = {
        type: "array",
        items: {
          type: "array",
          items: { type: "number" },
        },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([
        [1, 2],
        [3, 4],
      ]);
      expect(
        (result as any[]).every((arr: any[]) =>
          arr.every((item: any) => typeof item === "number")
        )
      ).toBe(true);
    });
  });

  describe("Edge cases and error handling", () => {
    it("should handle empty input gracefully", () => {
      const input = {};

      const schema = {
        type: "array",
        items: { type: "string" },
      };

      const result = coerceBySchema(input, schema);
      expect(result).toEqual({}); // Should return original when no matching patterns
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

  describe("Performance and scalability", () => {
    it("should handle large arrays efficiently", () => {
      const largeArray = Array.from({ length: 1000 }, (_, i) => i.toString());
      const input = { item: largeArray };

      const schema = {
        type: "array",
        items: { type: "number" },
      };

      const start = Date.now();
      const result = coerceBySchema(input, schema) as any[];
      const end = Date.now();

      const arr = result as any[];
      expect(arr).toHaveLength(1000);
      expect(arr.every((item: any) => typeof item === "number")).toBe(true);
      expect(end - start).toBeLessThan(100); // Should complete within 100ms
    });

    it("should handle deeply nested structures", () => {
      const input = {
        level1: {
          level2: {
            level3: {
              item: ["1", "2", "3"],
            },
          },
        },
      };

      const schema = {
        type: "object",
        properties: {
          level1: {
            type: "object",
            properties: {
              level2: {
                type: "object",
                properties: {
                  level3: {
                    type: "array",
                    items: { type: "number" },
                  },
                },
              },
            },
          },
        },
      };

      const result = coerceBySchema(input, schema) as any;
      expect(result.level1.level2.level3).toEqual([1, 2, 3]);
    });
  });
});
