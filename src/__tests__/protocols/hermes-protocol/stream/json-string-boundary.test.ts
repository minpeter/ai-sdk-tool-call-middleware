import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
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
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
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
    const tool = out.find((c) => c.type === "tool-call");
    expect(tool).toBeTruthy();
    if (tool?.type !== "tool-call") {
      throw new TypeError("Expected a tool-call part");
    }
    expect(tool.toolName).toBe("bash");
    expect(JSON.parse(tool.input)).toEqual({
      command: "echo '</tool_call>' test",
    });

    // No tool-call content should leak into text output
    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c) => c.delta)
      .join("");
    expect(text).not.toContain("<tool_call>");
    expect(text).not.toContain("</tool_call>");
  });

  it("does not split on </tool_call> inside a JSON string value split across chunks", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
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
    const tool = out.find((c) => c.type === "tool-call");
    expect(tool).toBeTruthy();
    if (tool?.type !== "tool-call") {
      throw new TypeError("Expected a tool-call part");
    }
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
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
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
    const tool = out.find((c) => c.type === "tool-call");
    expect(tool).toBeTruthy();
    if (tool?.type !== "tool-call") {
      throw new TypeError("Expected a tool-call part");
    }
    expect(tool.toolName).toBe("bash");
    expect(JSON.parse(tool.input)).toEqual({
      cmd: 'say "</tool_call>" ok',
    });
  });

  it("handles multiple false end tags in one string value (streaming)", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
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
    const tool = out.find((c) => c.type === "tool-call");
    expect(tool).toBeTruthy();
    if (tool?.type !== "tool-call") {
      throw new TypeError("Expected a tool-call part");
    }
    expect(tool.toolName).toBe("bash");
    expect(JSON.parse(tool.input)).toEqual({
      cmd: "first </tool_call> and second </tool_call> end",
    });
  });

  it("does not treat // inside a relaxed unquoted identifier as a comment", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '<tool_call>{name:"x",arguments:{path:a//b}}</tool_call>',
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
    expect(JSON.parse(tool.input)).toEqual({ path: "a//b" });
  });

  it("ignores </tool_call> and quotes inside relaxed line comments", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
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
    const tool = out.find((c) => c.type === "tool-call");
    expect(tool).toBeTruthy();
    if (tool?.type !== "tool-call") {
      throw new TypeError("Expected a tool-call part");
    }
    expect(tool.toolName).toBe("line_comment");
    expect(JSON.parse(tool.input)).toEqual({});
  });

  it("ignores </tool_call> inside a relaxed block comment split across chunks", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
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
    const tool = out.find((c) => c.type === "tool-call");
    expect(tool).toBeTruthy();
    if (tool?.type !== "tool-call") {
      throw new TypeError("Expected a tool-call part");
    }
    expect(tool.toolName).toBe("block_comment");
    expect(JSON.parse(tool.input)).toEqual({});
  });

  it("still parses normal streaming tool calls correctly (regression check)", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
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
    const tool = out.find((c) => c.type === "tool-call");
    expect(tool).toBeTruthy();
    if (tool?.type !== "tool-call") {
      throw new TypeError("Expected a tool-call part");
    }
    expect(tool.toolName).toBe("get_weather");
    expect(JSON.parse(tool.input)).toEqual({ city: "NYC" });

    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c) => c.delta)
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
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
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
    const toolInputStart = out.find((c) => c.type === "tool-input-start");
    expect(toolInputStart).toBeDefined();
    if (toolInputStart?.type !== "tool-input-start") {
      throw new TypeError("Expected a tool-input-start part");
    }
    expect(toolInputStart.toolName).toBe("bash");

    const toolCalls = out.filter((c) => c.type === "tool-call");
    expect(toolCalls.map((c) => c.toolName)).toEqual(["bash", "ok"]);
    expect(JSON.parse(toolCalls[0].input)).toEqual({ cmd: "x </tool_call> y" });
    expect(JSON.parse(toolCalls[1].input)).toEqual({});
  });

  it("parses a second <tool_call> that follows a fully closed first one in the same chunk", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
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
    const toolCalls = out.filter((c) => c.type === "tool-call");
    expect(toolCalls.map((c) => c.toolName)).toEqual(["bash", "ok"]);
  });

  it("does not treat an unquoted RJSON key matching a custom start delimiter as nested in streams", async () => {
    const protocol = hermesProtocol({
      toolCallStart: "name",
      toolCallEnd: "END",
    });
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: 'name{name:"ok",arguments:{}}END',
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
    expect(JSON.parse(toolCall.input)).toEqual({});
  });
});
