import { describe, expect, it, vi } from "vitest";
import {
  expectRejectedOutput,
  expectRejectedToolCall,
  expectToolCall,
  joinedText,
  jsonRepairParser,
  makeSchemaTool,
  makeTool,
  parseWithError,
} from "./json-repair-harness";

describe("json-repair.test split 2", () => {
  it.each([
    {
      name: "drops schema-unknown keys when additionalProperties is false",
      text: '<tool_call>{"name":"write","arguments":{"content":"He said "hi" there","debug":"drop me","path":"/tmp/a"}}</tool_call>',
      tool: makeTool(
        "write",
        { content: { type: "string" }, path: { type: "string" } },
        false
      ),
      expected: { content: 'He said "hi" there', path: "/tmp/a" },
    },
    {
      name: "drops schema-unknown keys in strict repair even when arguments parse cleanly",
      text: '<tool_call>{"name":"write","arguments":{"content":"ok","debug":"drop me","path":"/tmp/a"}}}</tool_call>',
      tool: makeTool(
        "write",
        { content: { type: "string" }, path: { type: "string" } },
        false
      ),
      expected: { content: "ok", path: "/tmp/a" },
    },
    {
      name: "drops schema-unknown keys for jsonSchema-wrapped strict schemas",
      text: '<tool_call>{"name":"write","arguments":{"content":"ok","debug":"drop me","path":"/tmp/a"}}}</tool_call>',
      tool: makeSchemaTool("write", {
        jsonSchema: {
          type: "object",
          properties: {
            content: { type: "string" },
            path: { type: "string" },
          },
          additionalProperties: false,
        },
      }),
      expected: { content: "ok", path: "/tmp/a" },
    },
    {
      name: "drops schema-unknown keys for clean strict JSON",
      text: '<tool_call>{"name":"write","arguments":{"content":"ok","debug":"drop me","path":"/tmp/a"}}</tool_call>',
      tool: makeTool(
        "write",
        { content: { type: "string" }, path: { type: "string" } },
        false
      ),
      expected: { content: "ok", path: "/tmp/a" },
    },
  ])("$name", ({ expected, text, tool }) => {
    const { onError, output } = parseWithError(text, [tool]);
    expect(JSON.parse(expectToolCall(output).input)).toEqual(expected);
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "rejects clean strict JSON with prototype-sensitive argument keys",
      text: '<tool_call>{"name":"write","arguments":{"content":"ok","__proto__":{"polluted":true}}}</tool_call>',
      allowUnknown: false,
    },
    {
      name: "rejects prototype-sensitive argument keys even when unknown keys are allowed",
      text: '<tool_call>{"name":"write","arguments":{"content":"ok","constructor":{"polluted":true}}}</tool_call>',
      allowUnknown: true,
    },
    {
      name: "rejects unquoted strict RJSON with prototype-sensitive argument keys",
      text: '<tool_call>{name:"write",arguments:{__proto__:{polluted:true},content:"ok"}}</tool_call>',
      allowUnknown: false,
    },
    {
      name: "rejects prototype-sensitive RJSON keys after leading comments",
      text: '<tool_call>/*{}*/{name:"write",arguments:{__proto__:{polluted:true},content:"ok"}}</tool_call>',
      allowUnknown: true,
    },
    {
      name: "rejects escaped single-quoted strict RJSON prototype-sensitive argument keys",
      text: '<tool_call>{name:"write",arguments:{\'\\u005f\\u005fproto__\':{polluted:true},content:"ok"}}</tool_call>',
      allowUnknown: false,
    },
  ])("$name", ({ allowUnknown, text }) => {
    expectRejectedToolCall(text, [
      makeTool("write", { content: { type: "string" } }, allowUnknown),
    ]);
  });

  it("rejects unquoted prototype-sensitive RJSON keys after comments", () => {
    const onError = vi.fn();
    const tools = [makeTool("write", { content: { type: "string" } }, false)];
    for (const prefix of ["/* comment */", "// comment\n"]) {
      onError.mockClear();
      const text = `<tool_call>{name:"write",arguments:{${prefix}__proto__:{polluted:true},content:"ok"}}</tool_call>`;
      const output = jsonRepairParser.parseGeneratedText({
        text,
        tools,
        options: { onError },
      });
      expectRejectedOutput(output, onError);
    }
  });

  it("drops double-encoded unicode prototype-sensitive keys without raw fallback text", () => {
    const argumentsText =
      '{"\\\\u0063onstructor":{"polluted":true},"content":"ok"}';
    const text = `<tool_call>${JSON.stringify({
      name: "write",
      arguments: argumentsText,
    })}</tool_call>`;
    const tools = [makeTool("write", { content: { type: "string" } }, false)];
    const { onError, output } = parseWithError(text, tools, {
      emitRawToolCallTextOnError: true,
    });

    expect(output.find((part) => part.type === "tool-call")).toBeUndefined();
    const fallbackText = joinedText(output);
    expect(fallbackText).not.toContain("<tool_call>");
    expect(fallbackText).not.toContain("\\u0063onstructor");
    expect(onError).toHaveBeenCalled();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain("\\u0063onstructor");
  });

  it("rejects prototype-sensitive non-object string arguments", () => {
    const text =
      '<tool_call>{"name":"echo","arguments":"<prototype>x</prototype>"}</tool_call>';
    const { onError, output } = parseWithError(
      text,
      [makeSchemaTool("echo", { type: "string" })],
      { emitRawToolCallTextOnError: true }
    );

    expect(output.some((part) => part.type === "tool-call")).toBe(false);
    expect(joinedText(output)).toBe("");
    expect(onError).toHaveBeenCalled();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain("<prototype>");
  });

  it("coerces top-level primitive string arguments by schema", () => {
    const text = '<tool_call>{"name":"count","arguments":"42"}</tool_call>';
    const output = jsonRepairParser.parseGeneratedText({
      text,
      tools: [makeSchemaTool("count", { type: "number" })],
    });
    const tool = expectToolCall(output);

    expect(tool.toolName).toBe("count");
    expect(tool.input).toBe("42");
  });

  it.each([
    "constructor: ordinary prose",
    "prototype: ordinary prose",
    "constructor: true",
  ] as const)("preserves schema-valid string argument value %s", (note) => {
    const text = `<tool_call>${JSON.stringify({
      name: "write",
      arguments: { note },
    })}</tool_call>`;
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: { note: { type: "string" } },
        additionalProperties: false,
      }),
    ];
    const tool = expectToolCall(
      jsonRepairParser.parseGeneratedText({ text, tools })
    );

    expect(tool.toolName).toBe("write");
    expect(JSON.parse(tool.input)).toEqual({ note });
  });
});
