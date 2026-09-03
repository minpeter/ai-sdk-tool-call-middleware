import type {
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

describe("json-repair.test split 6", () => {
  it("accepts unconstrained unsafe patternProperties when unknown keys are allowed", async () => {
    const onError = vi.fn();
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        patternProperties: {
          "^(a+)+$": {},
        },
        additionalProperties: true,
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
            '<tool_call>{"name":"write","arguments":{"aaaa":"ok"}}</tool_call>',
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
    expect(tool?.input).toBe('{"aaaa":"ok"}');
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps patternProperties-matching args when unknown keys are allowed even if pattern value coercion fails", async () => {
    const onError = vi.fn();
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        patternProperties: {
          "^x-": { type: "number" },
        },
        additionalProperties: true,
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
            '<tool_call>{"name":"write","arguments":{"x-debug":"not-number","other":"y"}}</tool_call>',
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
    expect(tool?.input).toBe('{"x-debug":"not-number","other":"y"}');
    expect(onError).not.toHaveBeenCalled();
  });

  it("fails closed for unsafe repeated patternProperties without groups", async () => {
    const onError = vi.fn();
    const slowKey = `${"a".repeat(24)}!`;
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
          delta: `<tool_call>{"name":"write","arguments":{"content":"ok","${slowKey}":"blocked"}}</tool_call>`,
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

  it("rejects prototype-sensitive argument keys without a schema policy", async () => {
    const onError = vi.fn();
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools: [],
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"edit","arguments":{"constructor":"pollute"}}</tool_call>',
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

  it("rejects nested prototype-sensitive argument keys", async () => {
    const onError = vi.fn();
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
            '<tool_call>{"name":"edit","arguments":{"payload":{"prototype":"pollute"}}}</tool_call>',
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

  it("rejects nested __proto__ argument keys parsed onto prototypes", async () => {
    const onError = vi.fn();
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
            '<tool_call>{"name":"edit","arguments":{"payload":{"__proto__":{"polluted":true}}}}</tool_call>',
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

  it("rejects missing required argument keys", async () => {
    const onError = vi.fn();
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
          delta: '<tool_call>{"name":"write","arguments":{}}</tool_call>',
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
});
