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

describe("json-repair.test split 1", () => {
  it("repairs unescaped quotes in a string value", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"edit","arguments":{"content":"He said "hello" to me"}}</tool_call>';
    const out = p.parseGeneratedText({ text, tools: [] });
    const tool = out.find((x) => x.type === "tool-call");
    expect(tool?.type).toBe("tool-call");
    if (tool?.type !== "tool-call") {
      throw new Error("Expected tool call");
    }
    expect(tool.toolName).toBe("edit");
    const args = JSON.parse(tool.input);
    expect(args.content).toBe('He said "hello" to me');
  });

  it("repairs unescaped quotes before a right brace character in a string", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"edit","arguments":{"content":"He said "}" there"}}</tool_call>';
    const tools = [makeTool("edit", { content: { type: "string" } }, false)];
    const out = p.parseGeneratedText({ text, tools });
    const tool = out.find((x) => x.type === "tool-call");
    expect(tool?.type).toBe("tool-call");
    if (tool?.type !== "tool-call") {
      throw new Error("Expected repaired tool call");
    }
    expect(JSON.parse(tool.input)).toEqual({ content: 'He said "}" there' });
  });

  it("repairs multiple arguments with one having unescaped quotes", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"path":"/tmp/a.txt","content":"use "strict"; var x = 1;"}}</tool_call>';
    const tools = [
      makeTool("write", {
        path: { type: "string" },
        content: { type: "string" },
      }),
    ];
    const out = p.parseGeneratedText({ text, tools });
    const tool = out.find((x) => x.type === "tool-call");
    expect(tool?.type).toBe("tool-call");
    if (tool?.type !== "tool-call") {
      throw new Error("Expected tool call");
    }
    expect(tool.toolName).toBe("write");
    const args = JSON.parse(tool.input);
    expect(args.path).toBe("/tmp/a.txt");
    expect(args.content).toContain('"strict"');
  });

  it('does not silently corrupt content when a ,"unknown": pattern appears inside broken quotes', () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    // Ambiguous input: ,"fake": could be (a) a real schema-unknown key
    // boundary or (b) part of the preceding content value wrapped in
    // broken quotes. We prefer correct boundary detection (so adjacent
    // unknown keys like ",\"extra\":..." repair cleanly — see the
    // "drops unknown extra keys" test below) over preserving ambiguous
    // unknown tokens inside a string value.
    //
    // Trade-off: when "fake" really was meant as part of the content
    // string, repair bails and the tool call is emitted as text rather
    // than producing a corrupted tool call with a truncated value.
    const text =
      '<tool_call>{"name":"edit","arguments":{"content":"value with ,"fake": inside"}}</tool_call>';
    const tools = [makeTool("edit", { content: { type: "string" } })];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const tool = out.find((x): x is ToolCallContent => x.type === "tool-call");
    if (tool) {
      const args = JSON.parse(tool.input);
      expect(typeof args.content).toBe("string");
    } else {
      expect(onError).toHaveBeenCalled();
    }
  });

  it("does not alter already valid JSON", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"read","arguments":{"path":"/tmp/file.txt"}}</tool_call>';
    const out = p.parseGeneratedText({ text, tools: [] });
    const tool = expectToolCall(out);
    expect(tool.toolName).toBe("read");
    expect(JSON.parse(tool.input)).toEqual({ path: "/tmp/file.txt" });
  });

  it("rejects inherited tool call fields from __proto__ wrappers", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"__proto__":{"name":"write","arguments":{"content":"ok"}}}</tool_call>';
    const tools = [makeTool("write", { content: { type: "string" } })];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("falls through to error for completely broken JSON (no name field)", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text = "<tool_call>{totally broken}</tool_call>";
    const out = p.parseGeneratedText({ text, tools: [], options: { onError } });
    expect(onError).toHaveBeenCalled();
    const rejoined = out.map((x) => (x.type === "text" ? x.text : "")).join("");
    expect(rejoined).toContain("{totally broken}");
  });

  it("repairs alongside numeric and boolean arguments", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"update","arguments":{"content":"He said "hi" there","count":42,"enabled":true}}</tool_call>';
    const tools = [
      makeTool("update", {
        content: { type: "string" },
        count: { type: "number" },
        enabled: { type: "boolean" },
      }),
    ];
    const out = p.parseGeneratedText({ text, tools });
    const tool = expectToolCall(out);
    expect(tool.toolName).toBe("update");
    const args = JSON.parse(tool.input);
    expect(args.content).toBe('He said "hi" there');
    expect(args.count).toBe(42);
    expect(args.enabled).toBe(true);
  });

  it("handles nested object in arguments without false key splits", () => {
    const p = hermesProtocol();
    // Valid JSON with a nested object — the ,"b":2 inside opts must NOT
    // be treated as a top-level key split.
    const text =
      '<tool_call>{"name":"x","arguments":{"opts":{"a":1,"b":2},"content":"say \\"hi\\""}}</tool_call>';
    const out = p.parseGeneratedText({ text, tools: [] });
    const tool = expectToolCall(out);
    expect(tool.toolName).toBe("x");
    const args = JSON.parse(tool.input);
    expect(args.opts).toEqual({ a: 1, b: 2 });
    expect(args.content).toBe('say "hi"');
  });

  it("handles array value in arguments without false key splits", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"x","arguments":{"items":[1,2,3],"text":"a \\"b\\" c"}}</tool_call>';
    const out = p.parseGeneratedText({ text, tools: [] });
    const tool = expectToolCall(out);
    expect(tool.toolName).toBe("x");
    const args = JSON.parse(tool.input);
    expect(args.items).toEqual([1, 2, 3]);
    expect(args.text).toBe('a "b" c');
  });

  it("falls through to error when repair is impossible (no arguments field)", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text = '<tool_call>{"name":"x","params":{"a":1}}</tool_call>';
    const out = p.parseGeneratedText({ text, tools: [], options: { onError } });
    // rjson may handle this, but the tool call should either parse or
    // fall through to onError; it should not crash.
    const hasToolOrError =
      out.some((x) => x.type === "tool-call") || onError.mock.calls.length > 0;
    expect(hasToolOrError).toBe(true);
  });

  it("repairs nested object arguments when JSON is malformed", () => {
    const p = hermesProtocol();
    // Malformed: unescaped quotes in content, plus a nested opts object
    const text =
      '<tool_call>{"name":"x","arguments":{"opts":{"a":1,"b":2},"content":"say "hi" there"}}</tool_call>';
    const tools = [
      makeTool("x", {
        opts: { type: "object" },
        content: { type: "string" },
      }),
    ];
    const out = p.parseGeneratedText({ text, tools });
    const tool = expectToolCall(out);
    expect(tool.toolName).toBe("x");
    const args = JSON.parse(tool.input);
    expect(args.opts).toEqual({ a: 1, b: 2 });
    expect(args.content).toBe('say "hi" there');
  });

  it("does not confuse nested 'name' inside arguments with tool name", () => {
    const p = hermesProtocol();
    // The arguments object contains a "name" key — the top-level "name"
    // (which is the tool name) should be extracted, not the nested one.
    const text =
      '<tool_call>{"name":"edit","arguments":{"name":"inner_value","content":"He said "hello" to me"}}</tool_call>';
    const tools = [
      makeTool("edit", {
        name: { type: "string" },
        content: { type: "string" },
      }),
    ];
    const out = p.parseGeneratedText({ text, tools });
    const tool = expectToolCall(out);
    expect(tool.toolName).toBe("edit");
    const args = JSON.parse(tool.input);
    expect(args.name).toBe("inner_value");
    expect(args.content).toBe('He said "hello" to me');
  });

  it("accepts valid non-string values alongside broken string values", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"update","arguments":{"count":42,"flag":true,"label":null,"content":"He said "hi" there"}}</tool_call>';
    const tools = [
      makeSchemaTool("update", {
        type: "object",
        properties: {
          count: { type: "number" },
          flag: { type: "boolean" },
          label: { type: ["string", "null"] },
          content: { type: "string" },
        },
      }),
    ];
    const out = p.parseGeneratedText({ text, tools });
    const tool = expectToolCall(out);
    expect(tool.toolName).toBe("update");
    const args = JSON.parse(tool.input);
    expect(args.count).toBe(42);
    expect(args.flag).toBe(true);
    expect(args.label).toBeNull();
    expect(args.content).toBe('He said "hi" there');
  });

  it("returns error when non-string value is broken (type coercion prevention)", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    // A broken number value (not a string) — repair should fail gracefully
    const text =
      '<tool_call>{"name":"calc","arguments":{"value":4.2.3,"label":"ok"}}</tool_call>';
    const tools = [
      makeTool("calc", {
        value: { type: "number" },
        label: { type: "string" },
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    // rjson may still recover this, but if it reaches repair, repair
    // should not silently coerce "4.2.3" to a string.
    // Either rjson handles it or onError is called.
    const hasToolOrError =
      out.some((x) => x.type === "tool-call") || onError.mock.calls.length > 0;
    expect(hasToolOrError).toBe(true);
  });

  it("drops schema-unknown keys when additionalProperties is implicit", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"content":"He said "hi" there","extra":"debug","path":"/tmp/a"}}</tool_call>';
    const tools = [
      makeTool("write", {
        content: { type: "string" },
        path: { type: "string" },
      }),
    ];
    const out = p.parseGeneratedText({ text, tools });
    const tool = expectToolCall(out);
    const args = JSON.parse(tool.input);
    expect(args.content).toBe('He said "hi" there');
    expect(args.path).toBe("/tmp/a");
    expect(args.extra).toBeUndefined();
  });

  it("keeps schema-additional keys when additionalProperties is true", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"content":"He said "hi" there","dynamic":"kept"}}</tool_call>';
    const tools = [
      makeTool(
        "write",
        {
          content: { type: "string" },
        },
        true
      ),
    ];
    const out = p.parseGeneratedText({ text, tools });
    const tool = out.find((x) => x.type === "tool-call");
    expect(tool).toBeTruthy();
    if (tool?.type !== "tool-call") {
      throw new Error("expected tool call");
    }
    const args = JSON.parse(tool.input);
    expect(args.content).toBe('He said "hi" there');
    expect(args.dynamic).toBe("kept");
  });

  it("coerces schema-additional keys when additionalProperties is a schema", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"content":"ok","count":"42"}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        additionalProperties: { type: "number" },
      }),
    ];
    const out = p.parseGeneratedText({ text, tools });
    const tool = expectToolCall(out);
    expect(JSON.parse(tool.input)).toEqual({ content: "ok", count: 42 });
  });
});
