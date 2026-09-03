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

describe("json-repair.test split 2", () => {
  it("drops schema-unknown keys when additionalProperties is false", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"content":"He said "hi" there","debug":"drop me","path":"/tmp/a"}}</tool_call>';
    const tools = [
      makeTool(
        "write",
        {
          content: { type: "string" },
          path: { type: "string" },
        },
        false
      ),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const tool = expectToolCall(out);
    const args = JSON.parse(tool.input);
    expect(args).toEqual({
      content: 'He said "hi" there',
      path: "/tmp/a",
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops schema-unknown keys in strict repair even when arguments parse cleanly", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"content":"ok","debug":"drop me","path":"/tmp/a"}}}</tool_call>';
    const tools = [
      makeTool(
        "write",
        {
          content: { type: "string" },
          path: { type: "string" },
        },
        false
      ),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const tool = expectToolCall(out);
    expect(JSON.parse(tool.input)).toEqual({
      content: "ok",
      path: "/tmp/a",
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops schema-unknown keys for jsonSchema-wrapped strict schemas", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"content":"ok","debug":"drop me","path":"/tmp/a"}}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        jsonSchema: {
          type: "object",
          properties: {
            content: { type: "string" },
            path: { type: "string" },
          },
          additionalProperties: false,
        },
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const tool = expectToolCall(out);
    expect(JSON.parse(tool.input)).toEqual({
      content: "ok",
      path: "/tmp/a",
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops schema-unknown keys for clean strict JSON", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"content":"ok","debug":"drop me","path":"/tmp/a"}}</tool_call>';
    const tools = [
      makeTool(
        "write",
        {
          content: { type: "string" },
          path: { type: "string" },
        },
        false
      ),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const tool = expectToolCall(out);
    expect(JSON.parse(tool.input)).toEqual({
      content: "ok",
      path: "/tmp/a",
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("rejects clean strict JSON with prototype-sensitive argument keys", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"content":"ok","__proto__":{"polluted":true}}}</tool_call>';
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

  it("rejects prototype-sensitive argument keys even when unknown keys are allowed", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"content":"ok","constructor":{"polluted":true}}}</tool_call>';
    const tools = [
      makeTool(
        "write",
        {
          content: { type: "string" },
        },
        true
      ),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("rejects unquoted strict RJSON with prototype-sensitive argument keys", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{name:"write",arguments:{__proto__:{polluted:true},content:"ok"}}</tool_call>';
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

  it("rejects unquoted prototype-sensitive RJSON keys after comments", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const tools = [makeTool("write", { content: { type: "string" } }, false)];
    for (const prefix of ["/* comment */", "// comment\n"]) {
      onError.mockClear();
      const text = `<tool_call>{name:"write",arguments:{${prefix}__proto__:{polluted:true},content:"ok"}}</tool_call>`;
      const out = p.parseGeneratedText({ text, tools, options: { onError } });
      expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
      expect(onError).toHaveBeenCalled();
    }
  });

  it("rejects prototype-sensitive RJSON keys after leading comments", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const tools = [makeTool("write", { content: { type: "string" } }, true)];
    const text =
      '<tool_call>/*{}*/{name:"write",arguments:{__proto__:{polluted:true},content:"ok"}}</tool_call>';
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("rejects escaped single-quoted strict RJSON prototype-sensitive argument keys", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{name:"write",arguments:{\'\\u005f\\u005fproto__\':{polluted:true},content:"ok"}}</tool_call>';
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

  it("drops double-encoded unicode prototype-sensitive keys without raw fallback text", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const argumentsText =
      '{"\\\\u0063onstructor":{"polluted":true},"content":"ok"}';
    const text = `<tool_call>${JSON.stringify({
      name: "write",
      arguments: argumentsText,
    })}</tool_call>`;
    const tools = [
      makeTool(
        "write",
        {
          content: { type: "string" },
        },
        false
      ),
    ];

    const out = p.parseGeneratedText({
      text,
      tools,
      options: { emitRawToolCallTextOnError: true, onError },
    });

    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    const joinedText = out
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(joinedText).not.toContain("<tool_call>");
    expect(joinedText).not.toContain("\\u0063onstructor");
    expect(onError).toHaveBeenCalled();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain("\\u0063onstructor");
  });

  it("rejects prototype-sensitive non-object string arguments", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"echo","arguments":"<prototype>x</prototype>"}</tool_call>';
    const tools = [makeSchemaTool("echo", { type: "string" })];

    const out = p.parseGeneratedText({
      text,
      tools,
      options: { emitRawToolCallTextOnError: true, onError },
    });

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(
      out
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    ).toBe("");
    expect(onError).toHaveBeenCalled();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain("<prototype>");
  });

  it("coerces top-level primitive string arguments by schema", () => {
    const p = hermesProtocol();
    const text = '<tool_call>{"name":"count","arguments":"42"}</tool_call>';
    const tools = [makeSchemaTool("count", { type: "number" })];

    const out = p.parseGeneratedText({ text, tools });
    const tool = expectToolCall(out);

    expect(tool.toolName).toBe("count");
    expect(tool.input).toBe("42");
  });

  it.each([
    "constructor: ordinary prose",
    "prototype: ordinary prose",
    "constructor: true",
  ] as const)("preserves schema-valid string argument value %s", (note) => {
    const p = hermesProtocol();
    const text = `<tool_call>${JSON.stringify({
      name: "write",
      arguments: { note },
    })}</tool_call>`;
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          note: { type: "string" },
        },
        additionalProperties: false,
      }),
    ];

    const out = p.parseGeneratedText({ text, tools });
    const tool = expectToolCall(out);

    expect(tool.toolName).toBe("write");
    expect(JSON.parse(tool.input)).toEqual({ note });
  });
});
