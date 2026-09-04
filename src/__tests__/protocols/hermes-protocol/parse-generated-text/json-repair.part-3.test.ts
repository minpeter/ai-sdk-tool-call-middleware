import { describe, expect, it } from "vitest";
import {
  expectOptionalToolCallInput,
  expectRejectedToolCall,
  expectToolCall,
  expectTruthyToolCall,
  jsonRepairParser,
  makeSchemaTool,
  makeTool,
  parseWithError,
} from "./json-repair-harness";

describe("json-repair.test split 3", () => {
  it("accepts coercible keys before strict schema validation", () => {
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
    const tool = expectTruthyToolCall(
      jsonRepairParser.parseGeneratedText({ text, tools })
    );
    expect(JSON.parse(tool.input)).toEqual({
      text: "Ship",
      targetLanguage: "fr",
      formality: "casual",
    });
  });

  it("rejects __proto__ keys in strict repair bookkeeping", () => {
    const text =
      '<tool_call>{"name":"write","arguments":{"__proto__":{"content":"bypass"},"content":"He said "hi" there"}}</tool_call>';
    const tools = [makeTool("write", { content: { type: "string" } }, false)];
    expectRejectedToolCall(text, tools);
  });

  it("keeps patternProperties keys when properties are declared", () => {
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
    const tool = expectTruthyToolCall(
      jsonRepairParser.parseGeneratedText({ text, tools })
    );
    expect(JSON.parse(tool.input)).toEqual({
      content: "ok",
      "x-debug": "kept",
      "y-trace": "yes",
      "z-123": "num",
      path: "/tmp/a",
    });
  });

  it("keeps non-capturing patternProperties-only keys for strict schemas", () => {
    const text =
      '<tool_call>{"name":"write","arguments":{"x-":"ok"}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        patternProperties: { "^(?:x-)+$": { type: "string" } },
        additionalProperties: false,
      }),
    ];
    const { onError, output } = parseWithError(text, tools);
    expectOptionalToolCallInput(output, { "x-": "ok" });
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "drops patternProperties false matches for strict schemas",
      text: '<tool_call>{"name":"write","arguments":{"content":"ok","x-secret":"blocked"}}</tool_call>',
      schema: {
        type: "object" as const,
        properties: { content: { type: "string" as const } },
        patternProperties: { "^x-": false },
        additionalProperties: false,
      },
    },
    {
      name: "drops false property schemas for strict schemas",
      text: '<tool_call>{"name":"write","arguments":{"content":"ok","secret":"blocked"}}</tool_call>',
      schema: {
        type: "object" as const,
        properties: {
          content: { type: "string" as const },
          secret: false,
        },
        additionalProperties: false,
      },
    },
  ])("$name", ({ schema, text }) => {
    const { onError, output } = parseWithError(text, [
      makeSchemaTool("write", schema),
    ]);
    expect(JSON.parse(expectToolCall(output).input)).toEqual({ content: "ok" });
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "fails closed for unsafe patternProperties without regex backtracking",
      pattern: "^(a+)+$",
    },
    {
      name: "fails closed for unsafe repeated patternProperties without groups",
      pattern: "^a+a+$",
    },
  ])("$name", ({ pattern }) => {
    const slowKey = `${"a".repeat(24)}!`;
    const text = `<tool_call>{"name":"write","arguments":{"content":"ok","${slowKey}":"blocked"}}</tool_call>`;
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: { content: { type: "string" } },
        patternProperties: { [pattern]: { type: "string" } },
        additionalProperties: false,
      }),
    ];
    expectRejectedToolCall(text, tools);
  });

  it.each([
    {
      name: "drops unsafe false patternProperties when unknown keys are allowed",
      argumentKey: `${"a".repeat(24)}!`,
      pattern: "^(a+)+$",
    },
    {
      name: "drops unsafe false patternProperties with character classes",
      argumentKey: "123",
      pattern: "^(a|[0-9])+$",
    },
    {
      name: "drops unsafe false patternProperties with escaped literals",
      argumentKey: "aaaa",
      pattern: "^(\\x61+)+$",
    },
    {
      name: "drops unsafe false patternProperties with unknown matchers",
      argumentKey: "secret",
      pattern: "^([^\\n]+)+$",
    },
  ])("$name", ({ argumentKey, pattern }) => {
    const text = `<tool_call>{"name":"write","arguments":{"content":"ok","${argumentKey}":"blocked"}}</tool_call>`;
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: { content: { type: "string" } },
        patternProperties: { [pattern]: false },
        additionalProperties: true,
      }),
    ];
    const { onError, output } = parseWithError(text, tools);
    expect(JSON.parse(expectToolCall(output).input)).toEqual({ content: "ok" });
    expect(onError).not.toHaveBeenCalled();
  });

  it("preserves safe additional keys when an unsafe false pattern contains character classes", () => {
    const text =
      '<tool_call>{"name":"write","arguments":{"content":"ok","note":"safe"}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: { content: { type: "string" } },
        patternProperties: { "^(a|[0-9])+$": false },
        additionalProperties: true,
      }),
    ];
    const { onError, output } = parseWithError(text, tools);
    const tool = output.find((part) => part.type === "tool-call");
    expect(tool).toBeTruthy();
    expect(tool?.type === "tool-call" ? JSON.parse(tool.input) : null).toEqual({
      content: "ok",
      note: "safe",
    });
    expect(onError).not.toHaveBeenCalled();
  });
});
