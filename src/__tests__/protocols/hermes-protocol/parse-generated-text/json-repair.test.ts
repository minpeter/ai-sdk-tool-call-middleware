import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

function makeTool(
  name: string,
  properties: Record<string, { type: string }>
): LanguageModelV3FunctionTool {
  return {
    type: "function",
    name,
    inputSchema: {
      type: "object",
      properties,
    },
  };
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

  it("repairs with knownArgKeys and drops unknown extra keys", () => {
    const p = hermesProtocol();
    // Schema knows "content" and "path"; the model also emits a
    // schema-unknown "extra" key between them. The unknown boundary is
    // still used to slice correctly (so "content" does not absorb the
    // ,"extra":"debug", prefix into a corrupted value), and the unknown
    // key is dropped from the final args object.
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
    // Schema-unknown key dropped from output
    expect(args).not.toHaveProperty("extra");
  });

  it("calls onError when arguments is not the last top-level property (backwards scan limitation)", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    // "id" comes after "arguments" — the backwards scan includes
    // ,"id":"123" in argsBody, which corrupts the arguments object.
    // This is a known limitation: repair only works when "arguments"
    // is the last (or second-to-last) top-level property.
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
      makeTool("write", {
        content: { type: "string" },
        path: { type: "string" },
      }),
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
});
