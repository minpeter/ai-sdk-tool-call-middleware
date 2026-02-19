import { describe, expect, it } from "vitest";
import { coerceBySchema } from "../../schema-coerce";

describe("Coercion Heuristic Handling", () => {
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
});
