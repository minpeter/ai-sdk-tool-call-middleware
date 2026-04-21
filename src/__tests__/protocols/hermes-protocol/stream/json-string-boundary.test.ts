import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

describe("hermesProtocol streaming – end tag inside JSON string values", () => {
  it("does not split on </tool_call> inside a JSON string value (single chunk)", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"bash","arguments":{"command":"echo \'</tool_call>\' test"}}</tool_call>',
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
    const tool = out.find((c) => c.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(tool.toolName).toBe("bash");
    expect(JSON.parse(tool.input)).toEqual({
      command: "echo '</tool_call>' test",
    });

    // No tool-call content should leak into text output
    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as any).delta)
      .join("");
    expect(text).not.toContain("<tool_call>");
    expect(text).not.toContain("</tool_call>");
  });

  it("does not split on </tool_call> inside a JSON string value split across chunks", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '<tool_call>{"name":"bash","arguments":{"command":"echo \'',
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "</tool_call>",
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "' test\"}}</tool_call>",
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
    const tool = out.find((c) => c.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(tool.toolName).toBe("bash");
    expect(JSON.parse(tool.input)).toEqual({
      command: "echo '</tool_call>' test",
    });
  });

  it("handles chunk split in the middle of an escape sequence", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    // The value is: say \"</tool_call>\" ok
    // We split the chunk right between the backslash and the quote
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '<tool_call>{"name":"bash","arguments":{"cmd":"say \\',
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '"</tool_call>\\',
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '" ok"}}</tool_call>',
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
    const tool = out.find((c) => c.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(tool.toolName).toBe("bash");
    expect(JSON.parse(tool.input)).toEqual({
      cmd: 'say "</tool_call>" ok',
    });
  });

  it("handles multiple false end tags in one string value (streaming)", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"bash","arguments":{"cmd":"first </tool_call>',
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: ' and second </tool_call> end"}}</tool_call>',
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
    const tool = out.find((c) => c.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(tool.toolName).toBe("bash");
    expect(JSON.parse(tool.input)).toEqual({
      cmd: "first </tool_call> and second </tool_call> end",
    });
  });

  it("ignores </tool_call> and quotes inside relaxed line comments", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{name:"line_comment",arguments:{}, // " </tool_call> inside comment\n}</tool_call>',
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
    const tool = out.find((c) => c.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(tool.toolName).toBe("line_comment");
    expect(JSON.parse(tool.input)).toEqual({});
  });

  it("ignores </tool_call> inside a relaxed block comment split across chunks", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '<tool_call>{name:"block_comment",arguments:{}, /* " </tool_',
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "call> inside comment */}</tool_call>",
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
    const tool = out.find((c) => c.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(tool.toolName).toBe("block_comment");
    expect(JSON.parse(tool.input)).toEqual({});
  });

  it("still parses normal streaming tool calls correctly (regression check)", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "before ",
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"get_weather","arguments":{"city":"NYC"}}</tool_call>',
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: " after",
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
    const tool = out.find((c) => c.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(tool.toolName).toBe("get_weather");
    expect(JSON.parse(tool.input)).toEqual({ city: "NYC" });

    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as any).delta)
      .join("");
    expect(text).toContain("before");
    expect(text).toContain("after");
    expect(text).not.toContain("<tool_call>");
    expect(text).not.toContain("</tool_call>");
  });

  it("parses adjacent tool calls when the first contains </tool_call> inside its JSON string value", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    // First tool call has a literal </tool_call> inside a JSON string value;
    // the parser must skip that end tag and close on the real one.
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"bash","arguments":{"cmd":"x </tool_call> y"}}</tool_call>' +
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
    expect(out.filter((c) => c.type === "finish").length).toBe(1);

    // The first tool call must be parsed with the inner </tool_call>
    // preserved inside its arguments (not truncated by the false end tag).
    const toolInputStart = out.find(
      (c) => c.type === "tool-input-start"
    ) as any;
    expect(toolInputStart).toBeDefined();
    expect(toolInputStart.toolName).toBe("bash");

    const toolCalls = out.filter((c) => c.type === "tool-call") as any[];
    expect(toolCalls.map((c) => c.toolName)).toEqual(["bash", "ok"]);
    expect(JSON.parse(toolCalls[0].input)).toEqual({ cmd: "x </tool_call> y" });
    expect(JSON.parse(toolCalls[1].input)).toEqual({});
  });

  it("parses a second <tool_call> that follows a fully closed first one in the same chunk", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"bash","arguments":{"cmd":"x </tool_call> y"}}</tool_call>' +
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
    const toolCalls = out.filter((c) => c.type === "tool-call") as any[];
    expect(toolCalls.map((c) => c.toolName)).toEqual(["bash", "ok"]);
  });

  it("reports and optionally emits raw text when recovering after a malformed nested start", async () => {
    const onError = vi.fn();
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools: [],
      options: { onError, emitRawToolCallTextOnError: true },
    });
    const malformedPrefix =
      '<tool_call>{"name":"bash","arguments":{"cmd":"x </tool_call> y"}} ';
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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
      .map((c) => (c as any).delta)
      .join("");
    expect(text).toContain(malformedPrefix);

    const toolCalls = out.filter((c) => c.type === "tool-call") as any[];
    expect(toolCalls.map((c) => c.toolName)).toEqual(["ok"]);

    expect(onError).toHaveBeenCalledTimes(1);
    const [message, metadata] = onError.mock.calls[0];
    expect(message).toContain("emitting original text");
    expect(metadata).toMatchObject({
      toolCall: malformedPrefix,
      toolName: "bash",
      dropReason: "malformed-nested-tool-call",
    });
    expect(metadata.toolCallId).toEqual(expect.any(String));
  });

  it("recovers a valid tool call that follows an unclosed/malformed one", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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

    const toolCalls = out.filter((c) => c.type === "tool-call") as any[];
    const okCall = toolCalls.find((c) => c.toolName === "ok");
    expect(okCall).toBeDefined();
  });
});
