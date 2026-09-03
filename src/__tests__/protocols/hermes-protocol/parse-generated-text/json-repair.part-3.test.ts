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

describe("json-repair.test split 3", () => {
  it("accepts coercible keys before strict schema validation", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"translate","arguments":{"text":"Ship","target_language":"fr","formality":"casual"}}</tool_call>';
    const tools = [
      makeSchemaTool("translate", {
        type: "object",
        properties: {
          text: { type: "string" },
          targetLanguage: { type: "string" },
          formality: { type: "string" },
        },
        required: ["text", "targetLanguage", "formality"],
        additionalProperties: false,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools });
    const tool = out.find((x) => x.type === "tool-call");
    expect(tool).toBeTruthy();
    if (tool?.type !== "tool-call") {
      throw new Error("expected tool call");
    }
    expect(JSON.parse(tool.input)).toEqual({
      text: "Ship",
      targetLanguage: "fr",
      formality: "casual",
    });
  });

  it("rejects __proto__ keys in strict repair bookkeeping", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"__proto__":{"content":"bypass"},"content":"He said "hi" there"}}</tool_call>';
    const tools = [
      makeTool(
        "write",
        {
          content: { type: "string" },
        },
        false
      ),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("keeps patternProperties keys when properties are declared", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"content":"ok","x-debug":"kept","y-trace":"yes","z-123":"num","path":"/tmp/a"}}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          content: { type: "string" },
          path: { type: "string" },
        },
        patternProperties: {
          "^(x|y)-": { type: "string" },
          "^z-[0-9]+$": { type: "string" },
        },
        additionalProperties: false,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools });
    const tool = out.find((x) => x.type === "tool-call");
    expect(tool).toBeTruthy();
    if (tool?.type !== "tool-call") {
      throw new Error("expected tool call");
    }
    const args = JSON.parse(tool.input);
    expect(args).toEqual({
      content: "ok",
      "x-debug": "kept",
      "y-trace": "yes",
      "z-123": "num",
      path: "/tmp/a",
    });
  });

  it("keeps non-capturing patternProperties-only keys for strict schemas", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"x-":"ok"}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        patternProperties: {
          "^(?:x-)+$": { type: "string" },
        },
        additionalProperties: false,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const tool = out.find((x) => x.type === "tool-call");
    expect(tool?.type).toBe("tool-call");
    expect(tool?.type === "tool-call" ? JSON.parse(tool.input) : null).toEqual({
      "x-": "ok",
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops patternProperties false matches for strict schemas", () => {
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
          "^x-": false,
        },
        additionalProperties: false,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const tool = expectToolCall(out);
    expect(JSON.parse(tool.input)).toEqual({ content: "ok" });
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops false property schemas for strict schemas", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"content":"ok","secret":"blocked"}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          content: { type: "string" },
          secret: false,
        },
        additionalProperties: false,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const tool = expectToolCall(out);
    expect(JSON.parse(tool.input)).toEqual({ content: "ok" });
    expect(onError).not.toHaveBeenCalled();
  });

  it("fails closed for unsafe patternProperties without regex backtracking", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const slowKey = `${"a".repeat(24)}!`;
    const text = `<tool_call>{"name":"write","arguments":{"content":"ok","${slowKey}":"blocked"}}</tool_call>`;
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        patternProperties: {
          "^(a+)+$": { type: "string" },
        },
        additionalProperties: false,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("fails closed for unsafe repeated patternProperties without groups", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const slowKey = `${"a".repeat(24)}!`;
    const text = `<tool_call>{"name":"write","arguments":{"content":"ok","${slowKey}":"blocked"}}</tool_call>`;
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        patternProperties: {
          "^a+a+$": { type: "string" },
        },
        additionalProperties: false,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("drops unsafe false patternProperties when unknown keys are allowed", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const slowKey = `${"a".repeat(24)}!`;
    const text = `<tool_call>{"name":"write","arguments":{"content":"ok","${slowKey}":"blocked"}}</tool_call>`;
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
    const tool = expectToolCall(out);
    expect(JSON.parse(tool.input)).toEqual({ content: "ok" });
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops unsafe false patternProperties with character classes", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"content":"ok","123":"blocked"}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        patternProperties: {
          "^(a|[0-9])+$": false,
        },
        additionalProperties: true,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const tool = expectToolCall(out);
    expect(JSON.parse(tool.input)).toEqual({ content: "ok" });
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops unsafe false patternProperties with escaped literals", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"content":"ok","aaaa":"blocked"}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        patternProperties: {
          "^(\\x61+)+$": false,
        },
        additionalProperties: true,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const tool = expectToolCall(out);
    expect(JSON.parse(tool.input)).toEqual({ content: "ok" });
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops unsafe false patternProperties with unknown matchers", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"content":"ok","secret":"blocked"}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        patternProperties: {
          "^([^\\n]+)+$": false,
        },
        additionalProperties: true,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const tool = expectToolCall(out);
    expect(JSON.parse(tool.input)).toEqual({ content: "ok" });
    expect(onError).not.toHaveBeenCalled();
  });

  it("preserves safe additional keys when an unsafe false pattern contains character classes", () => {
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
          "^(a|[0-9])+$": false,
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
});
