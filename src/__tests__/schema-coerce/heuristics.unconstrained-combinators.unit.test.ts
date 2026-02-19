import { describe, expect, it } from "vitest";
import { coerceBySchema } from "../../schema-coerce";

describe("Coercion Heuristic Handling", () => {
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
});
