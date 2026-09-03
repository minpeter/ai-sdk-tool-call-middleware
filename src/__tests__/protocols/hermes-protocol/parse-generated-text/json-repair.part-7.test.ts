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

describe("json-repair.test split 7", () => {
  it("rejects decimal strings for integer oneOf branches", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"edit","arguments":{"payload":{"value":"1.5"}}}</tool_call>';
    const tools = [
      makeSchemaTool("edit", {
        type: "object",
        properties: {
          payload: {
            oneOf: [
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
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("accepts oneOf object branches distinguished by nested enum values", () => {
    const p = hermesProtocol();
    const tools = [
      makeSchemaTool("edit", {
        type: "object",
        properties: {
          payload: {
            oneOf: [
              {
                type: "object",
                properties: { value: { type: "string", enum: ["a"] } },
                required: ["value"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: { value: { type: "string", enum: ["b"] } },
                required: ["value"],
                additionalProperties: false,
              },
            ],
          },
        },
        additionalProperties: false,
      }),
    ];
    for (const value of ["a", "b"]) {
      const onError = vi.fn();
      const text = `<tool_call>{"name":"edit","arguments":{"payload":{"value":"${value}"}}}</tool_call>`;
      const out = p.parseGeneratedText({ text, tools, options: { onError } });
      const tool = out.find((x) => x.type === "tool-call");
      expect(tool?.type).toBe("tool-call");
      expect(
        tool?.type === "tool-call" ? JSON.parse(tool.input) : null
      ).toEqual({
        payload: { value },
      });
      expect(onError).not.toHaveBeenCalled();
    }
  });

  it("accepts oneOf object branches distinguished by nested const values", () => {
    const p = hermesProtocol();
    const tools = [
      makeSchemaTool("edit", {
        type: "object",
        properties: {
          payload: {
            oneOf: [
              {
                type: "object",
                properties: {
                  kind: { const: "text" },
                  value: { type: "string" },
                },
                required: ["kind", "value"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  kind: { const: "count" },
                  value: { type: "integer" },
                },
                required: ["kind", "value"],
                additionalProperties: false,
              },
            ],
          },
        },
        additionalProperties: false,
      }),
    ];
    for (const [kind, value] of [
      ["text", '"hello"'],
      ["count", "3"],
    ]) {
      const onError = vi.fn();
      const text = `<tool_call>{"name":"edit","arguments":{"payload":{"kind":"${kind}","value":${value}}}}</tool_call>`;
      const out = p.parseGeneratedText({ text, tools, options: { onError } });
      const tool = out.find((x) => x.type === "tool-call");
      expect(tool?.type).toBe("tool-call");
      expect(onError).not.toHaveBeenCalled();
    }
  });

  it("rejects oneOf object branches with mismatched const values", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"edit","arguments":{"payload":{"kind":"count","value":"hello"}}}</tool_call>';
    const tools = [
      makeSchemaTool("edit", {
        type: "object",
        properties: {
          payload: {
            oneOf: [
              {
                type: "object",
                properties: {
                  kind: { const: "text" },
                  value: { type: "string" },
                },
                required: ["kind", "value"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  kind: { const: "count" },
                  value: { type: "integer" },
                },
                required: ["kind", "value"],
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

  it("drops object keys not declared by primitive oneOf branches", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"edit","arguments":{"payload":{"content":"ok","extra":"bad"}}}</tool_call>';
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
      payload: { content: "ok" },
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops stray keys before validating top-level anyOf branches", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"edit","arguments":{"city":"Seoul","stray":"drop"}}</tool_call>';
    const tools = [
      makeSchemaTool("edit", {
        anyOf: [
          {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { latitude: { type: "number" } },
            required: ["latitude"],
            additionalProperties: false,
          },
        ],
      }),
    ];

    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const tool = expectToolCall(out);
    expect(JSON.parse(tool.input)).toEqual({ city: "Seoul" });
    expect(onError).not.toHaveBeenCalled();
  });

  it("rejects top-level oneOf inputs with keys from multiple strict branches", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"edit","arguments":{"city":"Seoul","latitude":37.5}}</tool_call>';
    const tools = [
      makeSchemaTool("edit", {
        oneOf: [
          {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { latitude: { type: "number" } },
            required: ["latitude"],
            additionalProperties: false,
          },
        ],
      }),
    ];

    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    expect(out.find((part) => part.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("rejects top-level oneOf inputs with keys from multiple pattern branches", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"edit","arguments":{"x-a":"one","y-b":"two"}}</tool_call>';
    const tools = [
      makeSchemaTool("edit", {
        type: "object",
        oneOf: [
          {
            type: "object",
            patternProperties: {
              "^x-": { type: "string" },
            },
            additionalProperties: false,
          },
          {
            type: "object",
            patternProperties: {
              "^y-": { type: "string" },
            },
            additionalProperties: false,
          },
        ],
      }),
    ];

    const out = p.parseGeneratedText({ text, tools, options: { onError } });

    expect(out.find((part) => part.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });
});
