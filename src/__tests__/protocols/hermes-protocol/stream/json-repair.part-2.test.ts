import type {
  JSONSchema7,
  JSONSchema7Definition,
  JSONValue,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import type { ParserOptions } from "../../../../core/protocols/protocol-interface";
import {
  collectTextDeltas,
  requireToolCall,
  runProtocolTextStream,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";

type StreamError = NonNullable<ParserOptions["onError"]>;
interface WrappedSchema extends JSONSchema7 {
  readonly jsonSchema: JSONSchema7;
}

function schemaTool(
  name: string,
  inputSchema: JSONSchema7
): LanguageModelV4FunctionTool {
  return { type: "function", name, inputSchema };
}

function wrappedTool(name: string, jsonSchema: JSONSchema7) {
  const inputSchema: WrappedSchema = { jsonSchema };
  return schemaTool(name, inputSchema);
}

function parseStream(
  tools: LanguageModelV4FunctionTool[],
  text: string,
  onError?: StreamError,
  emitRawToolCallTextOnError = false
): Promise<LanguageModelV4StreamPart[]> {
  return runProtocolTextStream({
    protocol: hermesProtocol(),
    tools,
    chunks: [text],
    id: "1",
    parserOptions:
      onError === undefined
        ? undefined
        : { emitRawToolCallTextOnError, onError },
  });
}

function expectWriteCall(
  output: LanguageModelV4StreamPart[],
  expected: JSONValue,
  onError: StreamError
): void {
  const tool = requireToolCall(output);
  expect(tool.toolName).toBe("write");
  expect(JSON.parse(tool.input)).toEqual(expected);
  expect(onError).not.toHaveBeenCalled();
}

function expectNoToolLifecycle(
  output: LanguageModelV4StreamPart[],
  onError: StreamError
): void {
  const timeline = selectToolInputTimeline(output);
  expect(output.find((part) => part.type === "tool-call")).toBeUndefined();
  expect(timeline.starts).toHaveLength(0);
  expect(timeline.deltas).toHaveLength(0);
  expect(timeline.ends).toHaveLength(0);
  expect(onError).toHaveBeenCalled();
}

const strictWriteProperties = {
  path: { type: "string" },
  content: { type: "string" },
} satisfies Record<string, JSONSchema7Definition>;

describe("json-repair.test split 2", () => {
  it("drops schema-unknown keys for jsonSchema-wrapped strict schemas", async () => {
    const onError = vi.fn<StreamError>();
    const out = await parseStream(
      [
        wrappedTool("write", {
          type: "object",
          properties: strictWriteProperties,
          additionalProperties: false,
        }),
      ],
      '<tool_call>{"name":"write","arguments":{"content":"ok","debug":"drop me","path":"/tmp/a"}}}</tool_call>',
      onError
    );

    expectWriteCall(out, { content: "ok", path: "/tmp/a" }, onError);
  });

  it("drops schema-unknown keys for clean strict JSON", async () => {
    const onError = vi.fn<StreamError>();
    const out = await parseStream(
      [
        schemaTool("write", {
          type: "object",
          properties: strictWriteProperties,
          additionalProperties: false,
        }),
      ],
      '<tool_call>{"name":"write","arguments":{"content":"ok","debug":"drop me","path":"/tmp/a"}}</tool_call>',
      onError
    );

    expectWriteCall(out, { content: "ok", path: "/tmp/a" }, onError);
  });

  it("rejects clean strict JSON with prototype-sensitive argument keys", async () => {
    const onError = vi.fn<StreamError>();
    const out = await parseStream(
      [
        schemaTool("write", {
          type: "object",
          properties: { content: { type: "string" } },
          additionalProperties: false,
        }),
      ],
      '<tool_call>{"name":"write","arguments":{"content":"ok","__proto__":{"polluted":true}}}</tool_call>',
      onError
    );

    expectNoToolLifecycle(out, onError);
    const metadata = onError.mock.calls[0]?.[1];
    expect(metadata).toBeDefined();
    expect(metadata?.error).toBe("[redacted sensitive tool call]");
  });

  it("drops double-encoded unicode prototype-sensitive keys without raw fallback text", async () => {
    const onError = vi.fn<StreamError>();
    const argumentsText =
      '{"\\\\u0063onstructor":{"polluted":true},"content":"ok"}';
    const text = `<tool_call>${JSON.stringify({
      name: "write",
      arguments: argumentsText,
    })}</tool_call>`;
    const out = await parseStream(
      [
        schemaTool("write", {
          type: "object",
          properties: { content: { type: "string" } },
          additionalProperties: false,
        }),
      ],
      text,
      onError,
      true
    );

    expect(out.find((part) => part.type === "tool-call")).toBeUndefined();
    const emittedText = collectTextDeltas(out);
    expect(emittedText).not.toContain("<tool_call>");
    expect(emittedText).not.toContain("\\u0063onstructor");
    expect(onError).toHaveBeenCalled();
    expect(JSON.stringify(onError.mock.calls)).toContain(
      "[redacted sensitive tool call]"
    );
    expect(JSON.stringify(onError.mock.calls)).not.toContain(
      "\\u0063onstructor"
    );
  });

  it("rejects prototype-sensitive non-object string arguments", async () => {
    const onError = vi.fn<StreamError>();
    const text =
      '<tool_call>{"name":"echo","arguments":"<prototype>x</prototype>"}</tool_call>';
    const out = await parseStream(
      [schemaTool("echo", { type: "string" })],
      text,
      onError,
      true
    );

    const toolCall = out.find((part) => part.type === "tool-call");
    expect(toolCall).toBeUndefined();
    expect(collectTextDeltas(out)).toBe("");
    expect(onError).toHaveBeenCalled();
    const serializedErrors = JSON.stringify(onError.mock.calls);
    expect(serializedErrors).toContain("[redacted sensitive tool call]");
    expect(serializedErrors).not.toContain("<prototype>");
  });

  it("coerces top-level primitive string arguments by schema", async () => {
    const text = '<tool_call>{"name":"count","arguments":"42"}</tool_call>';
    const out = await parseStream(
      [schemaTool("count", { type: "number" })],
      text
    );
    const tool = requireToolCall(out);

    expect(tool.toolName).toBe("count");
    expect(tool.input).toBe("42");
    expect(
      selectToolInputTimeline(out)
        .deltas.map((part) => part.delta)
        .join("")
    ).toBe("42");
  });
});
