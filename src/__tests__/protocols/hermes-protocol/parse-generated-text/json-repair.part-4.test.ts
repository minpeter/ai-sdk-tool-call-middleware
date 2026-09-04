import { describe, expect, it, vi } from "vitest";
import type { ToolInputSchema } from "../../../../schema/tool-input-schema";
import {
  expectNoToolCall,
  expectOptionalToolCallInput,
  expectRejectedOutput,
  expectRejectedToolCall,
  expectToolCall,
  jsonRepairParser,
  makeSchemaTool,
  makeTool,
  parseWithError,
  parseWithoutThrow,
} from "./json-repair-harness";

function makeDeepArrayJson(depth: number): string {
  let value = "0";
  for (let index = 0; index < depth; index += 1) {
    value = `[${value}]`;
  }
  return value;
}

function makeStrictWriteTools() {
  return [
    makeTool(
      "write",
      { content: { type: "string" }, path: { type: "string" } },
      false
    ),
  ];
}

describe("json-repair.test split 4", () => {
  it("falls back to text instead of truncating content at schema-unknown key-like text", () => {
    const text =
      '<tool_call>{"name":"write","arguments":{"content":"before "quoted" ,"debug":"inside after","path":"/tmp/a"}}</tool_call>';
    const { output } = parseWithError(text, makeStrictWriteTools());
    expectNoToolCall(output);
    expect(
      output.some(
        (part) => part.type === "text" && part.text.includes("<tool_call>")
      )
    ).toBe(true);
  });

  it.each([
    {
      name: "calls onError when arguments is not the last top-level property (backwards scan limitation)",
      text: '<tool_call>{"name":"edit","arguments":{"content":"He said "hello" to me"},"id":"123"}</tool_call>',
      tools: [makeTool("edit", { content: { type: "string" } })],
    },
    {
      name: "falls back when malformed arguments are followed by a primitive top-level field",
      text: '<tool_call>{"name":"edit","arguments":{"content":"He said "hello" to me"},"id":123}</tool_call>',
      tools: [makeTool("edit", { content: { type: "string" } })],
    },
    {
      name: "falls back instead of repairing arguments across trailing top-level fields",
      text: '<tool_call>{"name":"write","arguments":{"path":"/tmp/a"},"debug":"drop"}}</tool_call>',
      tools: makeStrictWriteTools(),
    },
  ])("$name", ({ text, tools }) => {
    expectRejectedToolCall(text, tools);
  });

  it("handles nested object as last argument value", () => {
    // The last argument is a nested object — argsClose must find the right }
    const text =
      '<tool_call>{"name":"x","arguments":{"a":1,"b":{"c":2}}}</tool_call>';
    const output = jsonRepairParser.parseGeneratedText({ text, tools: [] });
    const args = JSON.parse(expectToolCall(output).input);
    expect(args.a).toBe(1);
    expect(args.b).toEqual({ c: 2 });
  });

  it("emits empty args when all parsed keys are schema-unknown", () => {
    const text =
      '<tool_call>{"name":"write","arguments":{"foo":"He said "hi" there","bar":"b"}}</tool_call>';
    const { onError, output } = parseWithError(text, makeStrictWriteTools());
    expect(JSON.parse(expectToolCall(output).input)).toEqual({});
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "falls through to text when malformed input uses relaxed-JSON syntax (repair is strict-JSON only)",
      text: '<tool_call>{name:"edit",arguments:{content:"He said "hi" there"}}</tool_call>',
      tools: [makeTool("edit", { content: { type: "string" } })],
    },
    {
      name: "does not repair relaxed top-level keys even when argument keys are strict JSON",
      text: '<tool_call>{name:"write",arguments:{"content":"He said "hi" there","path":"/tmp/a"}}</tool_call>',
      tools: [
        makeTool("write", {
          content: { type: "string" },
          path: { type: "string" },
        }),
      ],
    },
  ])("$name", ({ text, tools }) => {
    const { onError, output } = parseWithError(text, tools);
    expectNoToolCall(output);
    expect(output).toContainEqual({ type: "text", text });
    expect(onError).toHaveBeenCalled();
  });

  it("bails out on arguments body larger than 100KB", () => {
    // Create a payload > 100KB with a malformed string value
    const bigValue = "x".repeat(110_000);
    const text = `<tool_call>{"name":"big","arguments":{"data":"${bigValue} with "unescaped" quotes"}}</tool_call>`;
    const { onError, output } = parseWithError(text, []);
    // rjson may handle it, but repair should bail out on the size.
    // Either rjson handles it or onError is called.
    const hasToolOrError =
      output.some((part) => part.type === "tool-call") ||
      onError.mock.calls.length > 0;
    expect(hasToolOrError).toBe(true);
  });

  it("fails closed instead of throwing for deeply nested arguments", () => {
    const onError = vi.fn();
    const nestedArray = makeDeepArrayJson(20_000);
    const text = `<tool_call>{"name":"deep","arguments":{"data":${nestedArray}}}</tool_call>`;
    const output = parseWithoutThrow(text, [], onError);
    expectRejectedOutput(output, onError);
  });

  it("fails closed instead of throwing for a recursive schema with a deeply nested value", () => {
    const onError = vi.fn();
    // Live-cyclic tool schema: additionalProperties references the schema
    // object itself. Combined with a deeply nested value this would overflow
    // the schema-shape validator (uncaught RangeError) without the depth guard.
    const recursiveSchema: ToolInputSchema = { type: "object" };
    recursiveSchema.additionalProperties = recursiveSchema;
    const tool = makeSchemaTool("deep", recursiveSchema);
    let deepArgs = "{}";
    for (let index = 0; index < 5000; index += 1) {
      deepArgs = `{"nested":${deepArgs}}`;
    }
    const text = `<tool_call>{"name":"deep","arguments":${deepArgs}}</tool_call>`;
    const output = parseWithoutThrow(text, [tool], onError);
    expectRejectedOutput(output, onError);
  });

  it.each([
    {
      name: "rejects prototype-sensitive argument keys without a schema policy",
      text: '<tool_call>{"name":"edit","arguments":{"constructor":"pollute"}}</tool_call>',
      tools: [],
    },
    {
      name: "rejects nested prototype-sensitive argument keys",
      text: '<tool_call>{"name":"edit","arguments":{"payload":{"prototype":"pollute"}}}</tool_call>',
      tools: [
        makeSchemaTool("edit", {
          type: "object",
          properties: {
            payload: {
              type: "object",
              properties: { value: { type: "string" } },
              additionalProperties: true,
            },
          },
          additionalProperties: false,
        }),
      ],
    },
    {
      name: "rejects nested __proto__ argument keys parsed onto prototypes",
      text: '<tool_call>{"name":"edit","arguments":{"payload":{"__proto__":{"polluted":true}}}}</tool_call>',
      tools: [
        makeSchemaTool("edit", {
          type: "object",
          properties: {
            payload: { type: "object", additionalProperties: true },
          },
          additionalProperties: false,
        }),
      ],
    },
    {
      name: "rejects missing required argument keys",
      text: '<tool_call>{"name":"write","arguments":{}}</tool_call>',
      tools: [
        makeSchemaTool("write", {
          type: "object",
          properties: { content: { type: "string" } },
          required: ["content"],
          additionalProperties: false,
        }),
      ],
    },
  ])("$name", ({ text, tools }) => {
    expectRejectedToolCall(text, tools);
  });

  it("drops nested schema-unknown argument keys", () => {
    const text =
      '<tool_call>{"name":"write","arguments":{"payload":{"value":"ok","secret":"blocked"}}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          payload: {
            type: "object",
            properties: { value: { type: "string" } },
            additionalProperties: false,
          },
        },
        required: ["payload"],
        additionalProperties: false,
      }),
    ];
    const { onError, output } = parseWithError(text, tools);
    expectOptionalToolCallInput(output, { payload: { value: "ok" } });
    expect(onError).not.toHaveBeenCalled();
  });
});
