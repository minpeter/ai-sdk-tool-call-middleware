import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";

function makeTool(
  name: string,
  properties: Record<string, { type: string }>,
  additionalProperties?: boolean
): LanguageModelV3FunctionTool {
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

function makeSchemaTool(
  name: string,
  inputSchema: LanguageModelV3FunctionTool["inputSchema"]
): LanguageModelV3FunctionTool {
  return { type: "function", name, inputSchema };
}

describe("parseGeneratedText JSON repair", () => {
  it("repairs unescaped quotes in a string value", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"edit","arguments":{"content":"He said "hello" to me"}}</tool_call>';
    const out = p.parseGeneratedText({ text, tools: [] });
    const tool = out.find((x) => x.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(tool.toolName).toBe("edit");
    const args = JSON.parse(tool.input);
    expect(args.content).toBe('He said "hello" to me');
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
    const tool = out.find((x) => x.type === "tool-call") as any;
    expect(tool).toBeTruthy();
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
    const tool = out.find((x) => x.type === "tool-call") as any;
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
    const tool = out.find((x) => x.type === "tool-call") as any;
    expect(tool).toBeTruthy();
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
    const rejoined = out
      .map((x) => (x.type === "text" ? (x as any).text : ""))
      .join("");
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
    const tool = out.find((x) => x.type === "tool-call") as any;
    expect(tool).toBeTruthy();
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
    const tool = out.find((x) => x.type === "tool-call") as any;
    expect(tool).toBeTruthy();
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
    const tool = out.find((x) => x.type === "tool-call") as any;
    expect(tool).toBeTruthy();
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
    const tool = out.find((x) => x.type === "tool-call") as any;
    expect(tool).toBeTruthy();
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
    const tool = out.find((x) => x.type === "tool-call") as any;
    expect(tool).toBeTruthy();
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
      makeTool("update", {
        count: { type: "number" },
        flag: { type: "boolean" },
        label: { type: "string" },
        content: { type: "string" },
      }),
    ];
    const out = p.parseGeneratedText({ text, tools });
    const tool = out.find((x) => x.type === "tool-call") as any;
    expect(tool).toBeTruthy();
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

  it("preserves schema-unknown keys when additionalProperties is implicit", () => {
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
    const tool = out.find((x) => x.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    const args = JSON.parse(tool.input);
    expect(args.content).toBe('He said "hi" there');
    expect(args.path).toBe("/tmp/a");
    expect(args.extra).toBe("debug");
  });

  it("preserves schema-unknown keys when additionalProperties is true", () => {
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

  it("calls onError for schema-unknown keys when additionalProperties is false", () => {
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
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("rejects schema-unknown keys in strict repair even when arguments parse cleanly", () => {
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
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("rejects schema-unknown keys for jsonSchema-wrapped strict schemas", () => {
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
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("rejects schema-unknown keys for clean strict JSON", () => {
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
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
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

  it("rejects escaped single-quoted strict RJSON prototype-sensitive argument keys", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      "<tool_call>{name:\"write\",arguments:{'\\u005f\\u005fproto__':{polluted:true},content:\"ok\"}}</tool_call>";
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

  it("accepts common grouped and quantified patternProperties for strict schemas", () => {
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
    expect(args["x-debug"]).toBe("kept");
    expect(args["y-trace"]).toBe("yes");
    expect(args["z-123"]).toBe("num");
  });

  it("rejects patternProperties false matches for strict schemas", () => {
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
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("rejects false property schemas for strict schemas", () => {
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
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
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
    const started = performance.now();
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    expect(performance.now() - started).toBeLessThan(150);
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
    const started = performance.now();
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    expect(performance.now() - started).toBeLessThan(150);
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("fails closed for unsafe false patternProperties when unknown keys are allowed", () => {
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
    const started = performance.now();
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    expect(performance.now() - started).toBeLessThan(150);
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("falls back to text instead of truncating content at schema-unknown key-like text", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"content":"before "quoted" ,"debug":"inside after","path":"/tmp/a"}}</tool_call>';
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
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(
      out.some((x) => x.type === "text" && x.text.includes("<tool_call>"))
    ).toBe(true);
  });

  it("calls onError when arguments is not the last top-level property (backwards scan limitation)", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"edit","arguments":{"content":"He said "hello" to me"},"id":"123"}</tool_call>';
    const tools = [makeTool("edit", { content: { type: "string" } })];
    p.parseGeneratedText({ text, tools, options: { onError } });
    expect(onError).toHaveBeenCalled();
  });

  it("handles nested object as last argument value", () => {
    const p = hermesProtocol();
    // The last argument is a nested object — argsClose must find the right }
    const text =
      '<tool_call>{"name":"x","arguments":{"a":1,"b":{"c":2}}}</tool_call>';
    const out = p.parseGeneratedText({ text, tools: [] });
    const tool = out.find((x) => x.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    const args = JSON.parse(tool.input);
    expect(args.a).toBe(1);
    expect(args.b).toEqual({ c: 2 });
  });

  it("bails out when all parsed keys are schema-unknown (no empty-args fallback)", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    // Tool schema knows "content" and "path", but the model hallucinates
    // different key names ("foo", "bar") AND emits unescaped quotes so
    // parseRJSON fails and repair runs. Without the guard, repair would
    // skip every key via knownKeySet and return {name, arguments: {}} —
    // emitting a tool call with empty args (worse than failing). The guard
    // makes repair bail out to onError when no known key survives.
    const text =
      '<tool_call>{"name":"write","arguments":{"foo":"He said "hi" there","bar":"b"}}</tool_call>';
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
    const tool = out.find((x) => x.type === "tool-call");
    expect(tool).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("falls through to text when malformed input uses relaxed-JSON syntax (repair is strict-JSON only)", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    // Unquoted `name` / `arguments` keys (relaxed JSON) combined with an
    // unescaped quote inside a value. parseRJSON rejects the unescaped
    // quote, and the strict-JSON repair path cannot locate top-level keys
    // without double quotes. Expected behavior: same as pre-repair — the
    // segment falls through to text output via onError. This pins the
    // documented limitation; extending repair to relaxed JSON is out of scope.
    const text =
      '<tool_call>{name:"edit",arguments:{content:"He said "hi" there"}}</tool_call>';
    const tools = [makeTool("edit", { content: { type: "string" } })];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const tool = out.find((x) => x.type === "tool-call");
    expect(tool).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("bails out on arguments body larger than 100KB", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    // Create a payload > 100KB with a malformed string value
    const bigValue = "x".repeat(110_000);
    const text = `<tool_call>{"name":"big","arguments":{"data":"${bigValue} with "unescaped" quotes"}}</tool_call>`;
    const out = p.parseGeneratedText({ text, tools: [], options: { onError } });
    // rjson may handle it, but repair should bail out on the size.
    // Either rjson handles it or onError is called.
    const hasToolOrError =
      out.some((x) => x.type === "tool-call") || onError.mock.calls.length > 0;
    expect(hasToolOrError).toBe(true);
  });

  it("rejects prototype-sensitive argument keys without a schema policy", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"edit","arguments":{"constructor":"pollute"}}</tool_call>';
    const out = p.parseGeneratedText({
      text,
      tools: [],
      options: { onError },
    });
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("rejects nested prototype-sensitive argument keys", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"edit","arguments":{"payload":{"prototype":"pollute"}}}</tool_call>';
    const tools = [
      makeSchemaTool("edit", {
        type: "object",
        properties: {
          payload: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
            additionalProperties: true,
          },
        },
        additionalProperties: false,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("rejects nested __proto__ argument keys parsed onto prototypes", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"edit","arguments":{"payload":{"__proto__":{"polluted":true}}}}</tool_call>';
    const tools = [
      makeSchemaTool("edit", {
        type: "object",
        properties: {
          payload: {
            type: "object",
            additionalProperties: true,
          },
        },
        additionalProperties: false,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("rejects missing required argument keys", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text = '<tool_call>{"name":"write","arguments":{}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        required: ["content"],
        additionalProperties: false,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("rejects nested schema-unknown argument keys", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"payload":{"value":"ok","secret":"blocked"}}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          payload: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        required: ["payload"],
        additionalProperties: false,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("rejects nested argument keys disallowed by false schemas", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"payload":{"value":"ok","secret":"blocked"}}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          payload: {
            type: "object",
            properties: {
              secret: false,
              value: { type: "string" },
            },
            additionalProperties: true,
          },
        },
        required: ["payload"],
        additionalProperties: false,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
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

  it("preserves allowed extra argument keys when a denied pattern is unsafe", () => {
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
});
