import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import type { ParserOptions } from "../../../../core/protocols/protocol-interface";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

type OnError = NonNullable<ParserOptions["onError"]>;

describe("hermesProtocol streaming – comments and malformed recovery", () => {
  it("still treats // after a relaxed number literal as a comment", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{name:"x",arguments:{n:1// " </tool_call> inside comment\n}}</tool_call>',
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });

    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const tool = out.find((c) => c.type === "tool-call");
    expect(tool).toBeTruthy();
    if (tool?.type !== "tool-call") {
      throw new TypeError("Expected a tool-call part");
    }
    expect(tool.toolName).toBe("x");
    expect(JSON.parse(tool.input)).toEqual({ n: 1 });
  });

  it("does not treat a nested RJSON property matching a custom start delimiter as nested in streams", async () => {
    const protocol = hermesProtocol({
      toolCallStart: "name:",
      toolCallEnd: "END",
    });
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: 'name:{name:"ok",arguments:{name:{a:1}}}END',
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });

    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const toolCall = out.find((c) => c.type === "tool-call");
    expect(toolCall).toBeTruthy();
    if (toolCall?.type !== "tool-call") {
      throw new TypeError("Expected a tool-call part");
    }
    expect(toolCall.toolName).toBe("ok");
    expect(JSON.parse(toolCall.input)).toEqual({ name: { a: 1 } });
  });

  it("does not treat comma-delimited RJSON properties matching a custom delimiter as nested in streams", async () => {
    const protocol = hermesProtocol({
      toolCallStart: "name:",
      toolCallEnd: "END",
    });
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: 'name:{name:"ok",arguments:{x:1,name:{a:1}}}END',
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });

    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const toolCall = out.find((c) => c.type === "tool-call");
    expect(toolCall).toBeTruthy();
    if (toolCall?.type !== "tool-call") {
      throw new TypeError("Expected a tool-call part");
    }
    expect(toolCall.toolName).toBe("ok");
    expect(JSON.parse(toolCall.input)).toEqual({ x: 1, name: { a: 1 } });
  });

  it("does not treat spaced RJSON properties matching a custom delimiter as nested in streams", async () => {
    const protocol = hermesProtocol({
      toolCallStart: "name:",
      toolCallEnd: "END",
    });
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: 'name:{name:"ok",arguments:{x:1, name:{a:1}}}END',
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });

    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const toolCall = out.find((c) => c.type === "tool-call");
    expect(toolCall).toBeTruthy();
    if (toolCall?.type !== "tool-call") {
      throw new TypeError("Expected a tool-call part");
    }
    expect(toolCall.toolName).toBe("ok");
    expect(JSON.parse(toolCall.input)).toEqual({ x: 1, name: { a: 1 } });
  });

  it("recovers a valid tool call after an unterminated relaxed line comment consumes an end tag", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{name:"bad",arguments:{n:1//x}}</tool_call>' +
            '<tool_call>{"name":"ok","arguments":{}}</tool_call>',
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });

    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const toolCalls = out.filter((c) => c.type === "tool-call");
    expect(toolCalls.map((c) => c.toolName)).toEqual(["ok"]);
  });

  it("recovers a valid tool call after an unterminated relaxed block comment consumes an end tag", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{name:"bad",arguments:{n:1/*x}}</tool_call>' +
            '<tool_call>{"name":"ok","arguments":{}}</tool_call>',
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });

    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const toolCalls = out.filter((c) => c.type === "tool-call");
    expect(toolCalls.map((c) => c.toolName)).toEqual(["ok"]);
  });

  it("recovers a valid adjacent tool call after a malformed one without whitespace", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"bash","arguments":{"cmd":"x </tool_call> y"}}' +
            '<tool_call>{"name":"ok","arguments":{}}</tool_call>',
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });

    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const toolCalls = out.filter((c) => c.type === "tool-call");
    expect(toolCalls.map((c) => c.toolName)).toEqual(["ok"]);
  });

  it("reports and optionally emits raw text when recovering after a malformed nested start", async () => {
    const onError = vi.fn<OnError>();
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools: [],
      options: { onError, emitRawToolCallTextOnError: true },
    });
    const malformedPrefix =
      '<tool_call>{"name":"bash","arguments":{"cmd":"x </tool_call> y"}} ';
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: `${malformedPrefix}<tool_call>{"name":"ok","arguments":{}}</tool_call>`,
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });

    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );

    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c) => c.delta)
      .join("");
    expect(text).toContain(malformedPrefix);

    const toolCalls = out.filter((c) => c.type === "tool-call");
    expect(toolCalls.map((c) => c.toolName)).toEqual(["ok"]);

    expect(onError).toHaveBeenCalledTimes(1);
    const [message, metadata] = onError.mock.calls[0];
    if (metadata === undefined) {
      throw new TypeError("Expected error metadata");
    }
    expect(message).toContain("emitting original text");
    expect(metadata).toMatchObject({
      toolCall: malformedPrefix,
      toolName: "bash",
      dropReason: "malformed-nested-tool-call",
    });
    expect(
      metadata.toolCallId === undefined ||
        typeof metadata.toolCallId === "string"
    ).toBe(true);
  });

  it("recovers a valid tool call that follows an unclosed/malformed one", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"bash","arguments":{"cmd":"x </tool_call> y"}} ' +
            '<tool_call>{"name":"ok","arguments":{}}</tool_call>',
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });

    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    expect(out.some((c) => c.type === "finish")).toBe(true);

    const toolCalls = out.filter((c) => c.type === "tool-call");
    const okCall = toolCalls.find((c) => c.toolName === "ok");
    expect(okCall).toBeDefined();
  });
});
