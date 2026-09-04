import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import type {
  ParserOptions,
  ProtocolMetadata,
} from "../../../../core/protocols/protocol-interface";
import { mockUsage, stopFinishReason } from "../../../test-helpers";
import {
  collectProtocolStream,
  collectTextDeltas,
  runProtocolTextStream,
  selectToolCalls,
} from "../../shared/duplicate-harness";

type OnError = NonNullable<ParserOptions["onError"]>;

const protocol = hermesProtocol();

function runChunks(
  chunks: readonly string[],
  parserOptions?: ParserOptions
): Promise<LanguageModelV4StreamPart[]> {
  return runProtocolTextStream({
    protocol,
    tools: [],
    chunks,
    id: "1",
    parserOptions,
  });
}

function requireErrorMetadata(onError: ReturnType<typeof vi.fn<OnError>>) {
  expect(onError).toHaveBeenCalledTimes(1);
  const [call] = onError.mock.calls;
  if (call === undefined) {
    throw new TypeError("Expected error callback");
  }
  const [message, metadata] = call;
  if (metadata === undefined) {
    throw new TypeError("Expected error metadata");
  }
  return { message, metadata };
}

function expectGeneratedId(metadata: ProtocolMetadata): void {
  expect(typeof metadata.toolCallId).toBe("string");
  if (typeof metadata.toolCallId !== "string") {
    throw new TypeError("Expected generated tool-call ID");
  }
  expect(metadata.toolCallId.length).toBeGreaterThan(0);
}

describe("hermesProtocol streaming parsing and error policy", () => {
  it("parses normal tool_call blocks into tool-call events", async () => {
    const out = await runChunks([
      "pre ",
      '<tool_call>{"name":"x","arguments":{"a":1}}</tool_call>',
      " post",
    ]);
    const [tool] = selectToolCalls(out);
    if (tool === undefined) {
      throw new TypeError("Expected a tool-call part");
    }
    expect(tool.toolName).toBe("x");
    expect(JSON.parse(tool.input)).toEqual({ a: 1 });
  });

  it("normalizes legacy <tool_call> tags and parses", async () => {
    const [tool] = selectToolCalls(
      await runChunks(['<tool_call>{"name":"y","arguments":{}}</tool_call>'])
    );
    if (tool === undefined) {
      throw new TypeError("Expected a tool-call part");
    }
    expect(tool.toolName).toBe("y");
  });

  const parseErrorCases = [
    {
      name: "on parse error suppresses raw fallback text by default and calls onError",
      raw: "<tool_call>{bad}</tool_call>",
      emitRaw: false,
      expectedText: "<tool_call>",
    },
    {
      name: "on parse error emits raw fallback text when explicitly enabled",
      raw: "<tool_call>{bad}</tool_call>",
      emitRaw: true,
      expectedText: "<tool_call>{bad}</tool_call>",
    },
    {
      name: "emits original text on malformed JSON when raw fallback is enabled",
      raw: "<tool_call>{invalid}</tool_call>",
      emitRaw: true,
      expectedText: "<tool_call>{invalid}</tool_call>",
    },
  ];

  for (const testCase of parseErrorCases) {
    it(testCase.name, async () => {
      const onError = vi.fn<OnError>();
      const out = await runChunks([testCase.raw], {
        onError,
        emitRawToolCallTextOnError: testCase.emitRaw,
      });
      const text = collectTextDeltas(out);
      if (testCase.emitRaw) {
        expect(text).toContain(testCase.expectedText);
        expect(out.some((part) => part.type === "text-start")).toBe(true);
        expect(out.some((part) => part.type === "text-end")).toBe(true);
      } else {
        expect(text).not.toContain("<tool_call>");
        expect(text).not.toContain("</tool_call>");
        expect(out.some((part) => part.type === "text-start")).toBe(false);
        expect(out.some((part) => part.type === "text-end")).toBe(false);
      }
      expect(onError).toHaveBeenCalled();
    });
  }

  it("parses tool call when content split across chunks", async () => {
    const parts: LanguageModelV4StreamPart[] = [
      { type: "text-delta", id: "1", delta: "before <tool_call>" },
      { type: "text-delta", id: "1", delta: '{"name":"a","arguments":{}' },
      { type: "text-delta", id: "1", delta: "}</tool_call> after" },
      {
        type: "finish",
        finishReason: stopFinishReason,
        usage: mockUsage(1, 2),
      },
    ];
    const out = await collectProtocolStream({ protocol, tools: [], parts });
    expect(selectToolCalls(out)[0]).toMatchObject({
      type: "tool-call",
      toolName: "a",
      input: "{}",
    });
    expect(collectTextDeltas(out)).toContain("before ");
    expect(out.find((part) => part.type === "finish")).toBeTruthy();
  });

  it("supports legacy <tool_call> tags mixed in chunks", async () => {
    const out = await runChunks([
      '<tool_call>{"name":"b","arguments":{}}',
      "</tool_call>",
    ]);
    expect(selectToolCalls(out)[0]).toMatchObject({
      type: "tool-call",
      toolName: "b",
    });
  });

  const partialFallbackCases = [
    {
      name: "flushes buffered partial tool_call at finish as text when enabled",
      emitRaw: true,
    },
    {
      name: "suppresses buffered partial tool_call at finish by default",
      emitRaw: false,
    },
  ];

  for (const testCase of partialFallbackCases) {
    it(testCase.name, async () => {
      const out = await runChunks(['<tool_call>{"name":"c"'], {
        emitRawToolCallTextOnError: testCase.emitRaw,
      });
      const text = collectTextDeltas(out);
      if (testCase.emitRaw) {
        expect(text).toContain('<tool_call>{"name":"c"');
      } else {
        expect(text).not.toContain("<tool_call>");
        expect(out.some((part) => part.type === "tool-call")).toBe(false);
      }
    });
  }

  const unfinishedMetadataCases = [
    {
      name: "passes toolName, toolCallId, and dropReason in onError when tool call is dropped at finish",
      raw: '<tool_call>{"name":"bash","arguments":{"command":"ls"',
      toolName: "bash",
    },
    {
      name: "passes truncated toolName in onError when name value is cut mid-string",
      raw: '<tool_call>{"name":"ba',
      toolName: undefined,
    },
    {
      name: "passes undefined toolName in onError when only arguments are present",
      raw: '<tool_call>{"arguments":{"command":"ls"}',
      toolName: undefined,
    },
    {
      name: "passes undefined toolName in onError when name is not parseable",
      raw: "<tool_call>{broken",
      toolName: undefined,
    },
  ];

  for (const testCase of unfinishedMetadataCases) {
    it(testCase.name, async () => {
      const onError = vi.fn<OnError>();
      await runChunks([testCase.raw], { onError });
      const { message, metadata } = requireErrorMetadata(onError);
      if (testCase.toolName === "bash") {
        expect(message).toContain(
          "Could not complete streaming JSON tool call at finish"
        );
        expect(message).not.toContain("emitting original text");
        expect(metadata).toMatchObject({
          toolName: "bash",
          dropReason: "unfinished-tool-call",
        });
        expect(typeof metadata.toolCall).toBe("string");
        expect(metadata.toolCall).toContain("<tool_call>");
        expect(metadata.toolCall).toContain('"name":"bash"');
      } else {
        expect(metadata.toolName).toBeUndefined();
        expect(metadata.dropReason).toBe("unfinished-tool-call");
      }
      expectGeneratedId(metadata);
    });
  }

  it("emits the raw tool-call text and flags message when emitRawToolCallTextOnError is true", async () => {
    const onError = vi.fn<OnError>();
    const out = await runChunks(
      ['<tool_call>{"name":"bash","arguments":{"command":"ls"'],
      { onError, emitRawToolCallTextOnError: true }
    );
    const { message, metadata } = requireErrorMetadata(onError);
    expect(message).toContain("emitting original text");
    expect(metadata).toMatchObject({
      toolName: "bash",
      dropReason: "unfinished-tool-call",
    });
    expect(typeof metadata.toolCallId).toBe("string");
    expect(metadata.toolCall).toContain('"name":"bash"');
    expect(collectTextDeltas(out)).toContain("<tool_call>");
  });

  it("parses a single call whose tags are split across many chunks (>=6)", async () => {
    const out = await runChunks([
      "<tool",
      "_ca",
      "ll>",
      '{"name":"d"',
      ',"argume',
      'nts":{',
      '"location"',
      ':"NY"',
      "}}",
      "</tool",
      "_",
      "call>",
    ]);
    const [tool] = selectToolCalls(out);
    expect(tool).toBeTruthy();
    if (tool === undefined) {
      throw new TypeError("Expected a tool-call part");
    }
    expect(JSON.parse(tool.input).location).toBe("NY");
    expect(tool.toolName).toBe("d");
  });

  const malformedBodyCases = [
    {
      name: "passes toolName, toolCallId, and malformed-tool-call-body dropReason in onError when a complete tool_call block has invalid JSON body",
      emitRaw: false,
    },
    {
      name: "emits the raw tool-call text and keeps structured metadata when emitRawToolCallTextOnError is true and JSON body is invalid",
      emitRaw: true,
    },
  ];

  for (const testCase of malformedBodyCases) {
    it(testCase.name, async () => {
      const onError = vi.fn<OnError>();
      const out = await runChunks(
        [
          '<tool_call>{"name":"bash","arguments": not valid json here}</tool_call>',
        ],
        { onError, emitRawToolCallTextOnError: testCase.emitRaw }
      );
      const { message, metadata } = requireErrorMetadata(onError);
      expect(message).toContain(
        testCase.emitRaw
          ? "emitting original text"
          : "Could not process streaming JSON tool call"
      );
      if (!testCase.emitRaw) {
        expect(message).not.toContain("emitting original text");
      }
      expect(metadata).toMatchObject({
        toolName: "bash",
        dropReason: "malformed-tool-call-body",
      });
      expectGeneratedId(metadata);
      if (testCase.emitRaw) {
        const textOutput = collectTextDeltas(out);
        expect(textOutput).toContain("<tool_call>");
        expect(textOutput).toContain("</tool_call>");
      } else {
        expect(typeof metadata.toolCall).toBe("string");
        expect(metadata.toolCall).toContain("<tool_call>");
        expect(metadata.toolCall).toContain("</tool_call>");
      }
    });
  }
});
