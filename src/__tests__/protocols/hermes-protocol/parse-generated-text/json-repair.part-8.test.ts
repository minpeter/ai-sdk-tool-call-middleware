import type {
  JSONSchema7Definition,
  JSONValue,
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";

function makeTool(
  name: string,
  properties: Record<string, JSONSchema7Definition>,
  additionalProperties?: boolean
): LanguageModelV4FunctionTool {
  return {
    type: "function",
    name,
    inputSchema: {
      type: "object",
      properties,
      ...(additionalProperties === undefined ? {} : { additionalProperties }),
    },
  };
}

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

describe("json-repair.test split 8", () => {
  it("selects top-level oneOf branches by discriminator before dropping mixed keys", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"edit","arguments":{"kind":"count","countOnly":3,"textOnly":"drop-me"}}</tool_call>';
    const tools = [
      makeSchemaTool("edit", {
        type: "object",
        oneOf: [
          {
            type: "object",
            properties: {
              kind: { enum: ["text"] },
              textOnly: { type: "string" },
            },
            required: ["kind", "textOnly"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { enum: ["count"] },
              countOnly: { type: "number" },
            },
            required: ["kind", "countOnly"],
            additionalProperties: false,
          },
        ],
      }),
    ];

    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const tool = expectToolCall(out);
    expect(JSON.parse(tool.input)).toEqual({
      kind: "count",
      countOnly: 3,
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not leak incomplete unicode-escaped Hermes candidates from direct parsing", () => {
    const p = hermesProtocol();
    const tools = [
      makeTool("get_weather", { city: { type: "string" } }),
      makeTool("lookup", { query: { type: "string" } }),
    ];

    const out = p.parseGeneratedText({
      text: '<tool_call>{"n\\u0061me":"get_weather","arguments":{"city":"Seoul","constructor":{"polluted":true}',
      tools,
    });

    expect(out).toEqual([]);
  });

  it("redacts prototype-sensitive error metadata", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"content":"ok","constructor":{"polluted":true}}}</tool_call>';
    const tools = [makeTool("write", { content: { type: "string" } })];

    const out = p.parseGeneratedText({ text, tools, options: { onError } });

    expect(out.find((part) => part.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain("constructor");
    expect(metadataText).not.toContain("polluted");
  });

  it("applies every matching property and pattern schema", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"edit","arguments":{"payload":{"other":"bad"}}}</tool_call>';
    const tools = [
      makeSchemaTool("edit", {
        type: "object",
        properties: {
          payload: {
            type: "object",
            additionalProperties: true,
          },
        },
        patternProperties: {
          "^payload$": {
            type: "object",
            properties: {
              must: { type: "string" },
            },
            required: ["must"],
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("preserves safe additional keys when a denied pattern is unsafe", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"content":"ok","note":"safe"}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        patternProperties: {
          "^(a+)+$": false,
        },
        additionalProperties: true,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const tool = out.find((x) => x.type === "tool-call");
    expect(tool).toBeTruthy();
    expect(tool?.type === "tool-call" ? JSON.parse(tool.input) : null).toEqual({
      content: "ok",
      note: "safe",
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("accepts unconstrained unsafe patternProperties when unknown keys are allowed", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"aaaa":"ok"}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        patternProperties: {
          "^(a+)+$": {},
        },
        additionalProperties: true,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const tool = expectToolCall(out);
    expect(JSON.parse(tool.input)).toEqual({ aaaa: "ok" });
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps patternProperties-matching args when unknown keys are allowed even if pattern value coercion fails", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"x-debug":"not-number","other":"y"}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        patternProperties: {
          "^x-": { type: "number" },
        },
        additionalProperties: true,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const tool = expectToolCall(out);
    expect(JSON.parse(tool.input)).toEqual({
      "x-debug": "not-number",
      other: "y",
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("rejects unsafe positive patternProperties that may match constrained keys", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"aaaa":123}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        patternProperties: {
          "^(a+)+$": { type: "string", enum: ["allowed"] },
        },
        additionalProperties: true,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("drops unsafe false patternProperties that may match key substrings", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"content":"ok","x-secret":"blocked"}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        patternProperties: {
          "(secret+)+": false,
        },
        additionalProperties: true,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const tool = expectToolCall(out);
    expect(JSON.parse(tool.input)).toEqual({ content: "ok" });
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops unsafe false patternProperties that may match unanchored suffixes", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"content":"ok","ba":"blocked"}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        patternProperties: {
          "(a+)+$": false,
        },
        additionalProperties: true,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const tool = expectToolCall(out);
    expect(JSON.parse(tool.input)).toEqual({ content: "ok" });
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops keys that may match unsafe false patterns with escaped range endpoints", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"content":"ok","m":"blocked"}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        patternProperties: {
          "^([a-\\x7a]+)+$": false,
        },
        additionalProperties: true,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const tool = expectToolCall(out);
    expect(JSON.parse(tool.input)).toEqual({ content: "ok" });
    expect(onError).not.toHaveBeenCalled();
  });
});
