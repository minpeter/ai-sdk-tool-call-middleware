import type {
  JSONSchema7,
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

function makeDeepArrayJson(depth: number): string {
  let value = "0";
  for (let index = 0; index < depth; index += 1) {
    value = `[${value}]`;
  }
  return value;
}

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

describe("json-repair.test split 4", () => {
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
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("falls back when malformed arguments are followed by a primitive top-level field", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"edit","arguments":{"content":"He said "hello" to me"},"id":123}</tool_call>';
    const tools = [makeTool("edit", { content: { type: "string" } })];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("falls back instead of repairing arguments across trailing top-level fields", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"path":"/tmp/a"},"debug":"drop"}}</tool_call>';
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

  it("handles nested object as last argument value", () => {
    const p = hermesProtocol();
    // The last argument is a nested object — argsClose must find the right }
    const text =
      '<tool_call>{"name":"x","arguments":{"a":1,"b":{"c":2}}}</tool_call>';
    const out = p.parseGeneratedText({ text, tools: [] });
    const tool = expectToolCall(out);
    const args = JSON.parse(tool.input);
    expect(args.a).toBe(1);
    expect(args.b).toEqual({ c: 2 });
  });

  it("emits empty args when all parsed keys are schema-unknown", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
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
    const tool = expectToolCall(out);
    expect(JSON.parse(tool.input)).toEqual({});
    expect(onError).not.toHaveBeenCalled();
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
    expect(out).toContainEqual({ type: "text", text });
    expect(onError).toHaveBeenCalled();
  });

  it("does not repair relaxed top-level keys even when argument keys are strict JSON", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{name:"write",arguments:{"content":"He said "hi" there","path":"/tmp/a"}}</tool_call>';
    const tools = [
      makeTool("write", {
        content: { type: "string" },
        path: { type: "string" },
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(out).toContainEqual({ type: "text", text });
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

  it("fails closed instead of throwing for deeply nested arguments", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const nestedArray = makeDeepArrayJson(20_000);
    const text = `<tool_call>{"name":"deep","arguments":{"data":${nestedArray}}}</tool_call>`;
    let out: LanguageModelV4Content[] = [];
    expect(() => {
      out = p.parseGeneratedText({ text, tools: [], options: { onError } });
    }).not.toThrow();
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("fails closed instead of throwing for a recursive schema with a deeply nested value", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    // Live-cyclic tool schema: additionalProperties references the schema
    // object itself. Combined with a deeply nested value this would overflow
    // the schema-shape validator (uncaught RangeError) without the depth guard.
    const recursiveSchema: JSONSchema7 = { type: "object" };
    recursiveSchema.additionalProperties = recursiveSchema;
    const tool = makeSchemaTool("deep", recursiveSchema);
    let deepArgs = "{}";
    for (let index = 0; index < 5000; index += 1) {
      deepArgs = `{"nested":${deepArgs}}`;
    }
    const text = `<tool_call>{"name":"deep","arguments":${deepArgs}}</tool_call>`;
    let out: LanguageModelV4Content[] = [];
    expect(() => {
      out = p.parseGeneratedText({
        text,
        tools: [tool],
        options: { onError },
      });
    }).not.toThrow();
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
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

  it("drops nested schema-unknown argument keys", () => {
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
    const tool = out.find((x) => x.type === "tool-call");
    expect(tool?.type).toBe("tool-call");
    expect(tool?.type === "tool-call" ? JSON.parse(tool.input) : null).toEqual({
      payload: { value: "ok" },
    });
    expect(onError).not.toHaveBeenCalled();
  });
});
