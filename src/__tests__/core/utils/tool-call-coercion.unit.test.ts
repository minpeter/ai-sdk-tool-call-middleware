import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import {
  coerceToolCallInput,
  coerceToolCallPart,
} from "../../../core/utils/tool-call-coercion";

describe("tool-call coercion utils", () => {
  const weatherTools: LanguageModelV4FunctionTool[] = [
    {
      type: "function",
      name: "get_weather",
      inputSchema: {
        type: "object",
        properties: {
          city: { type: "string" },
          unit: { type: "string" },
        },
      },
    },
  ];

  it("coerces stringified tool input by schema", () => {
    const input = coerceToolCallInput("calc", '{"a":"10","b":"false"}', [
      {
        type: "function",
        name: "calc",
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "boolean" },
          },
        },
      },
    ]);

    expect(input).toBe('{"a":10,"b":false}');
  });

  it("drops schema-unknown top-level input keys when properties are declared", () => {
    const input = coerceToolCallInput(
      "get_weather",
      { city: "Seoul", unit: "celsius", mood: "sunny" },
      weatherTools
    );

    expect(input).toBe('{"city":"Seoul","unit":"celsius"}');
  });

  it("drops schema-unknown top-level keys from stringified input", () => {
    const input = coerceToolCallInput(
      "get_weather",
      '{"city":"Seoul","unit":"celsius","mood":"sunny"}',
      weatherTools
    );

    expect(input).toBe('{"city":"Seoul","unit":"celsius"}');
  });

  it("rejects prototype-sensitive keys before schema sanitization can drop them", () => {
    const input = coerceToolCallInput(
      "get_weather",
      { city: "Seoul", constructor: { polluted: true } },
      weatherTools
    );

    expect(input).toBeUndefined();
  });

  it("rejects nested prototype-sensitive keys before schema coercion can drop them", () => {
    const input = coerceToolCallInput(
      "get_weather",
      { city: "Seoul", meta: { prototype: { polluted: true } } },
      weatherTools
    );

    expect(input).toBeUndefined();
  });

  it("drops every key when a strict object schema declares no properties", () => {
    const input = coerceToolCallInput("ping", { mood: "sunny" }, [
      {
        type: "function",
        name: "ping",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ]);

    expect(input).toBe("{}");
  });

  it("drops keys for strict patternProperties-only tool schemas", () => {
    const input = coerceToolCallInput("metadata", { "x-debug": "yes" }, [
      {
        type: "function",
        name: "metadata",
        inputSchema: {
          type: "object",
          patternProperties: {
            "^x-": { type: "string" },
          },
          additionalProperties: false,
        },
      },
    ]);

    expect(input).toBe("{}");
  });

  it("drops schema-unknown top-level keys from allOf-wrapped schemas", () => {
    const input = coerceToolCallInput(
      "get_weather",
      { city: "Seoul", mood: "sunny" },
      [
        {
          type: "function",
          name: "get_weather",
          inputSchema: {
            allOf: [
              {
                type: "object",
                properties: {
                  city: { type: "string" },
                },
              },
            ],
          },
        },
      ]
    );

    expect(input).toBe('{"city":"Seoul"}');
  });

  it("returns undefined when tool input is invalid JSON string", () => {
    const input = coerceToolCallInput("calc", "{", []);
    expect(input).toBeUndefined();
  });

  it("leaves null input unchanged for non-nullable schemas", () => {
    const input = coerceToolCallInput("calc", null, [
      {
        type: "function",
        name: "calc",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" } },
        },
      },
    ]);

    expect(input).toBeUndefined();
  });

  it("preserves null input when the schema allows null", () => {
    const input = coerceToolCallInput("calc", null, [
      {
        type: "function",
        name: "calc",
        inputSchema: {
          type: ["object", "null"],
          properties: { a: { type: "number" } },
        },
      },
    ]);

    expect(input).toBe("null");
  });

  it("coerceToolCallPart updates tool-call input when coercion succeeds", () => {
    const part = coerceToolCallPart(
      {
        type: "tool-call" as const,
        toolCallId: "id",
        toolName: "calc",
        input: '{"a":"10"}',
      },
      [
        {
          type: "function",
          name: "calc",
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" } },
          },
        },
      ]
    );

    expect(part.input).toBe('{"a":10}');
  });

  it("coerceToolCallPart leaves part unchanged when coercion fails", () => {
    const original = {
      type: "tool-call" as const,
      toolCallId: "id",
      toolName: "calc",
      input: "{",
    };
    const part = coerceToolCallPart(original, []);
    expect(part).toEqual(original);
  });
});
