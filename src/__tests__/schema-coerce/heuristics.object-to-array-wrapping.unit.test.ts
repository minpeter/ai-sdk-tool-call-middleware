import type { JSONObject, JSONSchema7, JSONValue } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { coerceBySchema } from "../../schema-coerce";

describe("Coercion Heuristic Handling", () => {
  describe("Object to array wrapping", () => {
    it("should wrap single object in array when schema expects array", () => {
      const input = {
        id: "1",
        content: "test",
        status: "completed",
        priority: "medium",
      };

      const schema: JSONSchema7 = {
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

      const result = coerceBySchema(input, schema) as JSONValue[];
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

      const schema: JSONSchema7 = {
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

      const result = coerceBySchema(input, schema) as JSONObject;
      const todos = result.todos as JSONValue[];
      expect(Array.isArray(todos)).toBe(true);
      expect(todos).toHaveLength(1);
      expect(todos[0]).toEqual({
        id: "1",
        content: "test",
        status: "completed",
        priority: "medium",
      });
    });

    it("should preserve array when schema expects array and input is already array", () => {
      const input = [{ id: "1" }, { id: "2" }];

      const schema: JSONSchema7 = {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
        },
      };

      const result = coerceBySchema(input, schema) as JSONValue[];
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

      const schema: JSONSchema7 = {
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

      const result = coerceBySchema(input, schema) as JSONValue[];
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

      const schema: JSONSchema7 = {
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

      const result = coerceBySchema(input, schema) as JSONValue[];
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

      const schema: JSONSchema7 = {
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

      const result = coerceBySchema(input, schema) as JSONValue[];
      expect(result).toEqual([{ field: ["status", "amount"], op: ["=", ">"] }]);
    });
  });
});
