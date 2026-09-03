import type {
  JSONValue,
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";

// Intentionally accepts malformed schemas so tests can exercise runtime rejection.
function makeSchemaTool(
  name: string,
  inputSchema: JSONValue
): LanguageModelV4FunctionTool {
  return {
    type: "function",
    name,
    inputSchema: inputSchema as LanguageModelV4FunctionTool["inputSchema"],
  };
}

type ToolCallContent = Extract<LanguageModelV4Content, { type: "tool-call" }>;

function expectToolCall(output: LanguageModelV4Content[]): ToolCallContent {
  const tool = output.find(
    (part): part is ToolCallContent => part.type === "tool-call"
  );
  expect(tool?.type).toBe("tool-call");
  if (!tool) {
    throw new Error("Expected tool call");
  }
  return tool;
}

describe("json-repair.test split 6", () => {
  it("rejects strict primitive property values that cannot be coerced", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"count","arguments":{"count":"abc"}}</tool_call>';
    const tools = [
      makeSchemaTool("count", {
        type: "object",
        properties: {
          count: { type: "integer" },
        },
        required: ["count"],
        additionalProperties: false,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("drops unknown keys through strict allOf schemas", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"safe":"ok","secret":"leak"}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        allOf: [
          {
            type: "object",
            properties: {
              safe: { type: "string" },
            },
            required: ["safe"],
            additionalProperties: false,
          },
        ],
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const tool = expectToolCall(out);
    expect(JSON.parse(tool.input)).toEqual({ safe: "ok" });
    expect(onError).not.toHaveBeenCalled();
  });

  it("sanitizes nested array item keys through allOf schemas", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"payload":[{"value":"ok","secret":"leak"}]}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          payload: {
            allOf: [
              {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    value: { type: "string" },
                  },
                  additionalProperties: false,
                },
              },
            ],
          },
        },
        additionalProperties: false,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const call = out.find((x) => x.type === "tool-call");
    expect(call).toMatchObject({
      type: "tool-call",
      toolName: "write",
      input: '{"payload":[{"value":"ok"}]}',
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("sanitizes nested tuple item keys through draft-07 items arrays", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"rows":[{"value":"ok","secret":"leak"}]}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: [
              {
                type: "object",
                properties: {
                  value: { type: "string" },
                },
                required: ["value"],
                additionalProperties: false,
              },
            ],
            additionalItems: false,
          },
        },
        required: ["rows"],
        additionalProperties: false,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    expect(out.find((x) => x.type === "tool-call")).toMatchObject({
      type: "tool-call",
      toolName: "write",
      input: '{"rows":[{"value":"ok"}]}',
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("rejects values that match multiple oneOf schemas", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"payload":{"a":"ok"}}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          payload: {
            oneOf: [
              {
                type: "object",
                properties: { a: { type: "string" } },
                required: ["a"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: { a: { type: "string" } },
                required: ["a"],
                additionalProperties: false,
              },
            ],
          },
        },
        additionalProperties: false,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("accepts values that match a primitive oneOf branch", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"edit","arguments":{"payload":"abc"}}</tool_call>';
    const tools = [
      makeSchemaTool("edit", {
        type: "object",
        properties: {
          payload: {
            oneOf: [
              {
                type: "object",
                properties: { content: { type: "string" } },
                required: ["content"],
                additionalProperties: false,
              },
              { type: "string" },
            ],
          },
        },
        additionalProperties: false,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const tool = out.find((x) => x.type === "tool-call");
    expect(tool?.type).toBe("tool-call");
    expect(tool?.type === "tool-call" ? JSON.parse(tool.input) : null).toEqual({
      payload: "abc",
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("accepts oneOf object branches distinguished by nested primitive value types", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"edit","arguments":{"payload":{"value":"abc"}}}</tool_call>';
    const tools = [
      makeSchemaTool("edit", {
        type: "object",
        properties: {
          payload: {
            oneOf: [
              {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: { value: { type: "number" } },
                required: ["value"],
                additionalProperties: false,
              },
            ],
          },
        },
        additionalProperties: false,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const tool = out.find((x) => x.type === "tool-call");
    expect(tool?.type).toBe("tool-call");
    expect(tool?.type === "tool-call" ? JSON.parse(tool.input) : null).toEqual({
      payload: { value: "abc" },
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not count numeric strings as numeric oneOf matches", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"edit","arguments":{"payload":{"value":"123"}}}</tool_call>';
    const tools = [
      makeSchemaTool("edit", {
        type: "object",
        properties: {
          payload: {
            oneOf: [
              {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: { value: { type: "integer" } },
                required: ["value"],
                additionalProperties: false,
              },
            ],
          },
        },
        additionalProperties: false,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const tool = out.find((x) => x.type === "tool-call");
    expect(tool?.type).toBe("tool-call");
    expect(tool?.type === "tool-call" ? JSON.parse(tool.input) : null).toEqual({
      payload: { value: "123" },
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("rejects non-finite numeric strings for number and integer schemas", () => {
    const p = hermesProtocol();
    const cases = [
      { schemaType: "number", value: "1e999" },
      { schemaType: "integer", value: "9".repeat(400) },
    ];
    for (const { schemaType, value } of cases) {
      const onError = vi.fn();
      const text = `<tool_call>{"name":"edit","arguments":{"value":${JSON.stringify(value)}}}</tool_call>`;
      const out = p.parseGeneratedText({
        text,
        tools: [
          makeSchemaTool("edit", {
            type: "object",
            properties: {
              value: { type: schemaType },
            },
            required: ["value"],
            additionalProperties: false,
          }),
        ],
        options: { onError },
      });
      expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
      expect(onError).toHaveBeenCalled();
    }
  });
});
