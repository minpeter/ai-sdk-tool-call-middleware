import { describe, expect, it } from "vitest";

import { coerceBySchema } from "..";

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

    it("should extract object from single key (single/multiple element consistency)", () => {
      // Single and multiple elements should be processed with same structure
      const singleItem = { user: { name: "Alice" } };
      const multiItems = { user: [{ name: "Alice" }, { name: "Bob" }] };

      const schema = {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      };

      const singleResult = coerceBySchema(singleItem, schema) as any[];
      const multiResult = coerceBySchema(multiItems, schema) as any[];

      // Single element: [{ name: "Alice" }]
      expect(singleResult).toEqual([{ name: "Alice" }]);
      // Multiple elements: [{ name: "Alice" }, { name: "Bob" }]
      expect(multiResult).toEqual([{ name: "Alice" }, { name: "Bob" }]);
    });

    it("should handle nested single key object extraction", () => {
      const input = {
        wrapper: {
          items: { id: "1", value: "test" },
        },
      };

      const schema = {
        type: "object",
        properties: {
          wrapper: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                value: { type: "string" },
              },
            },
          },
        },
      };

      const result = coerceBySchema(input, schema) as any;
      expect(result.wrapper).toEqual([{ id: "1", value: "test" }]);
    });

    it("should wrap multiple key objects in array when not extractable", () => {
      const input = {
        number: ["3", "5"],
        color: ["red", "blue"],
      };

      const schema = {
        type: "array",
        items: { type: "string" },
      };

      // Should wrap in array when multiple keys exist (can't extract)
      const result = coerceBySchema(input, schema) as any[];
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(input);
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

    it("should wrap mixed key type objects in array", () => {
      const input = {
        "0": "zero",
        name: "test",
      };

      const schema = {
        type: "array",
        items: { type: "string" },
      };

      // Mixed keys should be wrapped in array
      const result = coerceBySchema(input, schema) as any[];
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(input);
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

    it("should handle single numeric key with prefixItems", () => {
      const input = {
        "0": "123",
      };

      const schema = {
        type: "array",
        prefixItems: [{ type: "number" }],
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([123]);
      expect(typeof result[0]).toBe("number");
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

  describe("Object to array wrapping", () => {
    it("should wrap single object in array when schema expects array", () => {
      const input = {
        id: "1",
        content: "test",
        status: "completed",
        priority: "medium",
      };

      const schema = {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            content: { type: "string" },
            status: { type: "string" },
            priority: { type: "string" },
          },
        },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: "1",
        content: "test",
        status: "completed",
        priority: "medium",
      });
    });

    it("should wrap nested object in array when parent property expects array", () => {
      const input = {
        todos: {
          id: "1",
          content: "test",
          status: "completed",
          priority: "medium",
        },
      };

      const schema = {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                content: { type: "string" },
                status: { type: "string" },
                priority: { type: "string" },
              },
            },
          },
        },
      };

      const result = coerceBySchema(input, schema) as any;
      expect(Array.isArray(result.todos)).toBe(true);
      expect(result.todos).toHaveLength(1);
      expect(result.todos[0]).toEqual({
        id: "1",
        content: "test",
        status: "completed",
        priority: "medium",
      });
    });

    it("should preserve array when schema expects array and input is already array", () => {
      const input = [{ id: "1" }, { id: "2" }];

      const schema = {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
        },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
    });

    it("should handle complex objects that don't match item/numeric patterns", () => {
      const input = {
        name: "Task 1",
        nested: {
          value: "test",
        },
      };

      const schema = {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            nested: {
              type: "object",
              properties: {
                value: { type: "string" },
              },
            },
          },
        },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(input);
    });
  });
});
