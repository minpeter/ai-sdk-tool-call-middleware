import type {
  JSONSchema7Definition,
  JSONValue,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";

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

type ToolCallPart = Extract<LanguageModelV4StreamPart, { type: "tool-call" }>;

function isToolCallPart(part: LanguageModelV4StreamPart): part is ToolCallPart {
  return part.type === "tool-call";
}

describe("json-repair.test split 4", () => {
  it("rejects inherited tool call fields from __proto__ wrappers", async () => {
    const onError = vi.fn();
    const tools = [makeTool("write", { content: { type: "string" } })];
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"__proto__":{"name":"write","arguments":{"content":"ok"}}}</tool_call>',
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
    expect(out.find((c) => c.type === "tool-call")).toBeUndefined();
    expect(out.some((c) => c.type === "tool-input-start")).toBe(false);
    expect(out.some((c) => c.type === "tool-input-delta")).toBe(false);
    expect(out.some((c) => c.type === "tool-input-end")).toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  it("rejects __proto__ keys in strict repair bookkeeping", async () => {
    const onError = vi.fn();
    const tools = [
      makeTool(
        "write",
        {
          content: { type: "string" },
        },
        false
      ),
    ];
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"write","arguments":{"__proto__":{"content":"bypass"},"content":"He said "hi" there"}}</tool_call>',
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
    expect(out.find((c) => c.type === "tool-call")).toBeUndefined();
    expect(out.some((c) => c.type === "tool-input-start")).toBe(false);
    expect(out.some((c) => c.type === "tool-input-delta")).toBe(false);
    expect(out.some((c) => c.type === "tool-input-end")).toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  it("keeps patternProperties keys when properties are declared", async () => {
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        patternProperties: {
          "^(x|y)-": { type: "string" },
          "^z-[0-9]+$": { type: "string" },
        },
        additionalProperties: false,
      }),
    ];
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"write","arguments":{"content":"ok","x-debug":"kept","y-trace":"yes","z-123":"num","path":"/tmp/a"}}}</tool_call>',
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
      throw new Error("expected tool call");
    }
    const args = JSON.parse(tool.input);
    expect(args).toEqual({
      content: "ok",
      "x-debug": "kept",
      "y-trace": "yes",
      "z-123": "num",
      path: "/tmp/a",
    });
  });

  it("keeps non-capturing patternProperties-only keys for strict schemas", async () => {
    const onError = vi.fn();
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        patternProperties: {
          "^(?:x-)+$": { type: "string" },
        },
        additionalProperties: false,
      }),
    ];
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"write","arguments":{"x-":"ok"}}</tool_call>',
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
    expect(tool?.type).toBe("tool-call");
    expect(tool?.type === "tool-call" ? JSON.parse(tool.input) : null).toEqual({
      "x-": "ok",
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops args for schemas without declared properties when additionalProperties is false", async () => {
    const onError = vi.fn();
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        additionalProperties: false,
      }),
    ];
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"write","arguments":{"x-":"ok"}}</tool_call>',
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
    const tool = out.find(isToolCallPart);
    expect(tool?.input).toBe("{}");
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops patternProperties false matches for strict schemas", async () => {
    const onError = vi.fn();
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
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"write","arguments":{"content":"ok","x-secret":"blocked"}}</tool_call>',
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
    expect(tool?.type === "tool-call" ? JSON.parse(tool.input) : null).toEqual({
      content: "ok",
    });
    expect(out.some((c) => c.type === "tool-input-start")).toBe(true);
    expect(out.some((c) => c.type === "tool-input-delta")).toBe(true);
    expect(out.some((c) => c.type === "tool-input-end")).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops false property schemas for strict schemas", async () => {
    const onError = vi.fn();
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
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"write","arguments":{"content":"ok","secret":"blocked"}}</tool_call>',
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
    expect(tool?.type === "tool-call" ? JSON.parse(tool.input) : null).toEqual({
      content: "ok",
    });
    expect(out.some((c) => c.type === "tool-input-start")).toBe(true);
    expect(out.some((c) => c.type === "tool-input-delta")).toBe(true);
    expect(out.some((c) => c.type === "tool-input-end")).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });
});
