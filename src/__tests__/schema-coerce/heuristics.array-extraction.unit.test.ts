import { describe, expect, it } from "vitest";
import { coerceBySchema } from "../../schema-coerce";

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
});
