import { describe, expect, it } from "vitest";
import { coerceBySchema } from ".";

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

    it("should unwrap primitive wrapper objects for array item schemas", () => {
      const input = {
        to: {
          element: "legal@corp.com",
        },
      };

      const schema = {
        type: "array",
        items: { type: "string" },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual(["legal@corp.com"]);
    });

    it("should coerce primitive wrapper object values by item schema type", () => {
      const input = {
        number: {
          value: "42",
        },
      };

      const schema = {
        type: "array",
        items: { type: "integer" },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([42]);
    });

    it("should keep object value when primitive wrapper coercion is not possible", () => {
      const input = {
        payload: {
          value: { nested: "x" },
        },
      };

      const schema = {
        type: "array",
        items: { type: "string" },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([{ value: { nested: "x" } }]);
    });

    it("should unwrap wrapped primitive objects inside arrays", () => {
      const input = [{ element: "legal@corp.com" }];

      const schema = {
        type: "array",
        items: { type: "string" },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual(["legal@corp.com"]);
    });

    it("should unwrap wrapped primitive objects for tags array", () => {
      const input = [{ tag: "refund" }];

      const schema = {
        type: "array",
        items: { type: "string" },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual(["refund"]);
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
          additionalProperties: false,
        },
      };

      const singleResult = coerceBySchema(singleItem, schema) as any[];
      const multiResult = coerceBySchema(multiItems, schema) as any[];

      // Single element: [{ name: "Alice" }]
      expect(singleResult).toEqual([{ name: "Alice" }]);
      // Multiple elements: [{ name: "Alice" }, { name: "Bob" }]
      expect(multiResult).toEqual([{ name: "Alice" }, { name: "Bob" }]);
    });

    it("should not unwrap single key objects when items schema expects that key", () => {
      const input = { user: { name: "Alice" } };

      const schema = {
        type: "array",
        items: {
          type: "object",
          properties: {
            user: {
              type: "object",
              properties: { name: { type: "string" } },
            },
          },
          required: ["user"],
        },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([{ user: { name: "Alice" } }]);
    });

    it("should not unwrap single key objects when items schema allows additionalProperties", () => {
      const input = { foo: { bar: "1" } };

      const schema = {
        type: "array",
        items: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: { bar: { type: "string" } },
          },
        },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([{ foo: { bar: "1" } }]);
    });

    it("should not unwrap single key objects when items schema has implicit additionalProperties", () => {
      const input = { user: { name: "Alice" } };

      const schema = {
        type: "array",
        items: {
          type: "object",
        },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([{ user: { name: "Alice" } }]);
    });

    it("should not unwrap single key objects when items schema uses patternProperties", () => {
      const input = { foo: { bar: "1" } };

      const schema = {
        type: "array",
        items: {
          type: "object",
          patternProperties: {
            "^f": {
              type: "object",
              properties: { bar: { type: "string" } },
            },
          },
        },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([{ foo: { bar: "1" } }]);
    });

    it("should unwrap single key objects when patternProperties do not match and additionalProperties is false", () => {
      const input = { wrapper: { "x-id": "1" } };

      const schema = {
        type: "array",
        items: {
          type: "object",
          patternProperties: {
            "^x-": { type: "string" },
          },
          additionalProperties: false,
        },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([{ "x-id": "1" }]);
    });

    it("should unwrap single key objects when patternProperties explicitly disallow the key", () => {
      const input = { wrapper: { id: "1" } };

      const schema = {
        type: "array",
        items: {
          type: "object",
          patternProperties: {
            "^wrapper$": false,
          },
          additionalProperties: true,
        },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([{ id: "1" }]);
    });

    it("should unwrap single key objects when allOf disallows the wrapper key", () => {
      const input = { wrapper: { id: "1" } };

      const schema = {
        type: "array",
        items: {
          allOf: [
            {
              type: "object",
              properties: { id: { type: "string" } },
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                wrapper: {
                  type: "object",
                  properties: { id: { type: "string" } },
                },
              },
            },
          ],
        },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([{ id: "1" }]);
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
              additionalProperties: false,
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

  describe("Strict object key normalization", () => {
    it("renames singular key into required plural array key", () => {
      const input = {
        table: "orders",
        filter: [
          {
            field: "status",
            op: "=",
            value: "paid",
          },
        ],
        limit: "50",
      };

      const schema = {
        type: "object",
        properties: {
          table: { type: "string" },
          filters: {
            type: "array",
            items: {
              type: "object",
              properties: {
                field: { type: "string" },
                op: { type: "string" },
                value: { type: "string" },
              },
              required: ["field", "op", "value"],
              additionalProperties: false,
            },
          },
          limit: { type: "integer" },
        },
        required: ["table", "filters", "limit"],
        additionalProperties: false,
      };

      const result = coerceBySchema(input, schema) as any;
      expect(result).toEqual({
        table: "orders",
        filters: [
          {
            field: "status",
            op: "=",
            value: "paid",
          },
        ],
        limit: 50,
      });
    });

    it("renames snake_case key into required camelCase key", () => {
      const input = {
        text: "Let's ship this today.",
        target_language: "fr",
        formality: "casual",
      };

      const schema = {
        type: "object",
        properties: {
          text: { type: "string" },
          targetLanguage: { type: "string" },
          formality: { type: "string", enum: ["casual", "formal"] },
        },
        required: ["text", "targetLanguage", "formality"],
        additionalProperties: false,
      };

      const result = coerceBySchema(input, schema) as any;
      expect(result).toEqual({
        text: "Let's ship this today.",
        targetLanguage: "fr",
        formality: "casual",
      });
    });

    it("normalizes leading underscores when matching snake_case keys", () => {
      const input = {
        _target_language: "es",
      };

      const schema = {
        type: "object",
        properties: {
          targetLanguage: { type: "string" },
        },
        required: ["targetLanguage"],
        additionalProperties: false,
      };

      const result = coerceBySchema(input, schema) as any;
      expect(result).toEqual({
        targetLanguage: "es",
      });
    });

    it("renames camelCase key into required snake_case key", () => {
      const input = {
        targetLanguage: "ko",
      };

      const schema = {
        type: "object",
        properties: {
          target_language: { type: "string" },
        },
        required: ["target_language"],
        additionalProperties: false,
      };

      const result = coerceBySchema(input, schema) as any;
      expect(result).toEqual({
        target_language: "ko",
      });
    });

    it("does not rename when strict-object constraints are not met", () => {
      const input = {
        text: "hello",
        target_language: "fr",
      };

      const schema = {
        type: "object",
        properties: {
          text: { type: "string" },
          targetLanguage: { type: "string" },
        },
        required: ["text", "targetLanguage"],
        additionalProperties: true,
      };

      const result = coerceBySchema(input, schema) as any;
      expect(result).toEqual({
        text: "hello",
        target_language: "fr",
      });
    });

    it("does not apply semantic alias renames", () => {
      const input = {
        location: "Seoul",
        unit: "celsius",
        includeForecast: "true",
      };

      const schema = {
        type: "object",
        properties: {
          city: { type: "string" },
          unit: { type: "string" },
          includeForecast: { type: "boolean" },
        },
        required: ["city", "unit", "includeForecast"],
        additionalProperties: false,
      };

      const result = coerceBySchema(input, schema) as any;
      expect(result).toEqual({
        location: "Seoul",
        unit: "celsius",
        includeForecast: true,
      });
    });

    it("does not apply singular/plural rename when target is not an array schema", () => {
      const input = {
        filter: ["paid"],
      };

      const schema = {
        type: "object",
        properties: {
          filters: { type: "string" },
        },
        required: ["filters"],
        additionalProperties: false,
      };

      const result = coerceBySchema(input, schema) as any;
      expect(result).toEqual({
        filter: ["paid"],
      });
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

  describe("Unconstrained schema handling in combinators", () => {
    it("should not unwrap single key objects when anyOf has unconstrained branch (empty object)", () => {
      const input = { wrapper: { id: "1" } };

      const schema = {
        type: "array",
        items: {
          anyOf: [
            {},
            {
              type: "object",
              properties: { id: { type: "string" } },
              additionalProperties: false,
            },
          ],
        },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([{ wrapper: { id: "1" } }]);
    });

    it("should not unwrap single key objects when anyOf has unconstrained branch (true)", () => {
      const input = { wrapper: { id: "1" } };

      const schema = {
        type: "array",
        items: {
          anyOf: [
            true,
            {
              type: "object",
              properties: { id: { type: "string" } },
              additionalProperties: false,
            },
          ],
        },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([{ wrapper: { id: "1" } }]);
    });

    it("should not unwrap single key objects when oneOf has unconstrained branch", () => {
      const input = { wrapper: { name: "test" } };

      const schema = {
        type: "array",
        items: {
          oneOf: [
            {},
            {
              type: "object",
              properties: { name: { type: "string" } },
              additionalProperties: false,
            },
          ],
        },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([{ wrapper: { name: "test" } }]);
    });

    it("should not unwrap single key objects when allOf has unconstrained branch", () => {
      const input = { wrapper: { value: "42" } };

      const schema = {
        type: "array",
        items: {
          allOf: [{}, { type: "object" }],
        },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([{ wrapper: { value: "42" } }]);
    });

    it("should unwrap when all combinator branches disallow the wrapper key", () => {
      const input = { wrapper: { id: "1" } };

      const schema = {
        type: "array",
        items: {
          anyOf: [
            {
              type: "object",
              properties: { id: { type: "string" } },
              additionalProperties: false,
            },
            {
              type: "object",
              properties: { name: { type: "string" } },
              additionalProperties: false,
            },
          ],
        },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([{ id: "1" }]);
    });

    it("should not unwrap when items schema is unconstrained (null)", () => {
      const input = { wrapper: { id: "1" } };

      const schema = {
        type: "array",
        items: null,
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([{ wrapper: { id: "1" } }]);
    });

    it("should not unwrap when items schema is unconstrained (empty object)", () => {
      const input = { wrapper: { id: "1" } };

      const schema = {
        type: "array",
        items: {},
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([{ wrapper: { id: "1" } }]);
    });

    it("should not unwrap when items schema is boolean true", () => {
      const input = { wrapper: { id: "1" } };

      const schema = {
        type: "array",
        items: true,
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([{ wrapper: { id: "1" } }]);
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

    it("expands strict object-of-parallel-arrays into array-of-objects", () => {
      const input = {
        field: ["status", "amount"],
        op: ["=", ">"],
        value: ["paid", "100"],
      };

      const schema = {
        type: "array",
        items: {
          type: "object",
          properties: {
            field: { type: "string" },
            op: { type: "string" },
            value: { type: "string" },
          },
          required: ["field", "op", "value"],
          additionalProperties: false,
        },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([
        { field: "status", op: "=", value: "paid" },
        { field: "amount", op: ">", value: "100" },
      ]);
    });

    it("does not expand parallel arrays when additionalProperties is not false", () => {
      const input = {
        field: ["status", "amount"],
        op: ["=", ">"],
      };

      const schema = {
        type: "array",
        items: {
          type: "object",
          properties: {
            field: { type: "string" },
            op: { type: "string" },
          },
          additionalProperties: true,
        },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([{ field: ["status", "amount"], op: ["=", ">"] }]);
    });
  });

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

  describe("Primitive to string coercion", () => {
    it("coerces booleans into strings when schema expects string", () => {
      const result = coerceBySchema(false, { type: "string" });
      expect(result).toBe("false");
    });

    it("coerces numbers into strings when schema expects string", () => {
      const result = coerceBySchema(42, { type: "string" });
      expect(result).toBe("42");
    });

    it("coerces nested object properties into strings for string-typed keys", () => {
      const input = {
        op: true,
      };

      const schema = {
        type: "object",
        properties: {
          op: { type: "string" },
        },
        required: ["op"],
        additionalProperties: false,
      };

      const result = coerceBySchema(input, schema) as any;
      expect(result).toEqual({ op: "true" });
    });
  });

  describe("Enum whitespace canonicalization", () => {
    it("canonicalizes quoted enum tokens when quote removal yields a unique match", () => {
      const result = coerceBySchema("'high'", {
        type: "string",
        enum: ["low", "normal", "high"],
      });

      expect(result).toBe("high");
    });

    it("canonicalizes spaced enum tokens when there is exactly one match", () => {
      const result = coerceBySchema("1 d", {
        type: "string",
        enum: ["1d", "1w", "1m"],
      });

      expect(result).toBe("1d");
    });

    it("does not canonicalize ambiguous enum matches", () => {
      const result = coerceBySchema("a b", {
        type: "string",
        enum: ["ab", "a b"],
      });

      expect(result).toBe("a b");
    });

    it("does not canonicalize when enum includes non-string values", () => {
      const result = coerceBySchema("1 d", {
        type: "string",
        enum: [1, "1d"],
      });

      expect(result).toBe("1 d");
    });
  });
});
