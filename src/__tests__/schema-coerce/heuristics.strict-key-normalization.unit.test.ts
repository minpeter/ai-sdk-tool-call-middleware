import {
  isJSONObject,
  type JSONObject,
  type JSONSchema7,
  type JSONValue,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { coerceBySchema } from "../../schema-coerce";

interface KeyNormalizationCase {
  readonly expected: JSONObject;
  readonly input: JSONObject;
  readonly name: string;
}

const stringSchema: JSONSchema7 = { type: "string" };
const filterArraySchema: JSONSchema7 = {
  type: "array",
  items: {
    type: "object",
    properties: {
      field: stringSchema,
      op: stringSchema,
      value: stringSchema,
    },
    required: ["field", "op", "value"],
    additionalProperties: false,
  },
};
const camelCaseSchema: JSONSchema7 = {
  type: "object",
  properties: {
    text: { type: "string" },
    targetLanguage: { type: "string" },
    formality: { type: "string", enum: ["casual", "formal"] },
  },
  required: ["text", "targetLanguage", "formality"],
  additionalProperties: false,
};
const camelCaseCases: readonly KeyNormalizationCase[] = [
  {
    name: "renames snake_case key into required camelCase key",
    input: {
      text: "Let's ship this today.",
      target_language: "fr",
      formality: "casual",
    },
    expected: {
      text: "Let's ship this today.",
      targetLanguage: "fr",
      formality: "casual",
    },
  },
  {
    name: "renames case-style required keys even when unrelated extra keys are present",
    input: {
      text: "Let's ship this today.",
      target_language: "fr",
      formality: "casual",
      extra: "drop later",
    },
    expected: {
      text: "Let's ship this today.",
      targetLanguage: "fr",
      formality: "casual",
      extra: "drop later",
    },
  },
];

function coerceObject(input: JSONValue, schema: JSONSchema7): JSONObject {
  const result = coerceBySchema(input, schema);
  if (!isJSONObject(result)) {
    throw new TypeError("Expected object coercion result");
  }
  return result;
}

describe("Coercion Heuristic Handling", () => {
  describe("Strict object key normalization", () => {
    it("renames singular key into required plural array key", () => {
      const input = {
        table: "orders",
        filter: [{ field: "status", op: "=", value: "paid" }],
        limit: "50",
      };
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          table: { type: "string" },
          filters: filterArraySchema,
          limit: { type: "integer" },
        },
        required: ["table", "filters", "limit"],
        additionalProperties: false,
      };

      const result = coerceObject(input, schema);
      expect(result).toEqual({
        table: "orders",
        filters: [{ field: "status", op: "=", value: "paid" }],
        limit: 50,
      });
    });

    for (const { name, input, expected } of camelCaseCases) {
      it(name, () => {
        expect(coerceObject(input, camelCaseSchema)).toEqual(expected);
      });
    }

    it("normalizes leading underscores when matching snake_case keys", () => {
      const input = { _target_language: "es" };
      const schema: JSONSchema7 = {
        type: "object",
        properties: { targetLanguage: { type: "string" } },
        required: ["targetLanguage"],
        additionalProperties: false,
      };

      const result = coerceObject(input, schema);
      expect(result).toEqual({ targetLanguage: "es" });
    });

    it("renames camelCase key into required snake_case key", () => {
      const input = { targetLanguage: "ko" };
      const schema: JSONSchema7 = {
        type: "object",
        properties: { target_language: { type: "string" } },
        required: ["target_language"],
        additionalProperties: false,
      };

      const result = coerceObject(input, schema);
      expect(result).toEqual({ target_language: "ko" });
    });

    it("does not rename when strict-object constraints are not met", () => {
      const input = { text: "hello", target_language: "fr" };
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          text: { type: "string" },
          targetLanguage: { type: "string" },
        },
        required: ["text", "targetLanguage"],
        additionalProperties: true,
      };

      const result = coerceObject(input, schema);
      expect(result).toEqual({ text: "hello", target_language: "fr" });
    });

    it("does not apply semantic alias renames", () => {
      const input = {
        location: "Seoul",
        unit: "celsius",
        includeForecast: "true",
      };
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          city: { type: "string" },
          unit: { type: "string" },
          includeForecast: { type: "boolean" },
        },
        required: ["city", "unit", "includeForecast"],
        additionalProperties: false,
      };

      const result = coerceObject(input, schema);
      expect(result).toEqual({
        location: "Seoul",
        unit: "celsius",
        includeForecast: true,
      });
    });

    it("does not apply singular/plural rename when target is not an array schema", () => {
      const input = { filter: ["paid"] };
      const schema: JSONSchema7 = {
        type: "object",
        properties: { filters: { type: "string" } },
        required: ["filters"],
        additionalProperties: false,
      };

      const result = coerceObject(input, schema);
      expect(result).toEqual({ filter: ["paid"] });
    });

    it("renames singular required array keys even when unrelated extra keys are present", () => {
      const input = {
        filter: [{ field: "status", op: "=", value: "paid" }],
        extra: "drop later",
      };
      const schema: JSONSchema7 = {
        type: "object",
        properties: { filters: filterArraySchema },
        required: ["filters"],
        additionalProperties: false,
      };

      const result = coerceObject(input, schema);
      expect(result).toEqual({
        filters: [{ field: "status", op: "=", value: "paid" }],
        extra: "drop later",
      });
    });
  });
});
