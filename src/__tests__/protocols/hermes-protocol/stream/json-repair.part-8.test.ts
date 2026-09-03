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

function expectNoToolInputLifecycle(
  parts: readonly LanguageModelV4StreamPart[]
): void {
  expect(parts.some((part) => part.type === "tool-input-start")).toBe(false);
  expect(parts.some((part) => part.type === "tool-input-delta")).toBe(false);
  expect(parts.some((part) => part.type === "tool-input-end")).toBe(false);
}

describe("json-repair.test split 8", () => {
  it("rejects null for non-nullable typed object properties", async () => {
    const onError = vi.fn();
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools: [
        makeSchemaTool("write", {
          type: "object",
          properties: {
            content: { type: "string" },
          },
          required: ["content"],
          additionalProperties: false,
        }),
      ],
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"write","arguments":{"content":null}}</tool_call>',
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

  it("accepts null arguments when the top-level schema allows null", async () => {
    const onError = vi.fn();
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools: [
        makeSchemaTool("write", {
          type: ["object", "null"],
          properties: {
            content: { type: "string" },
          },
          additionalProperties: false,
        }),
      ],
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '<tool_call>{"name":"write","arguments":null}</tool_call>',
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
    expect(tool?.input).toBe("null");
    expect(out.some((c) => c.type === "tool-input-start")).toBe(true);
    expect(out.some((c) => c.type === "tool-input-delta")).toBe(true);
    expect(out.some((c) => c.type === "tool-input-end")).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it("rejects null arguments without a matching nullable schema", async () => {
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
          delta: '<tool_call>{"name":"write","arguments":null}</tool_call>',
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
    expectNoToolInputLifecycle(out);
    expect(onError).toHaveBeenCalled();
  });

  it("accepts null for nullable object and array properties", async () => {
    const onError = vi.fn();
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools: [
        makeSchemaTool("write", {
          type: "object",
          properties: {
            payload: {
              type: ["object", "null"],
              properties: { content: { type: "string" } },
              required: ["content"],
              additionalProperties: false,
            },
            rows: {
              type: ["array", "null"],
              items: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
            },
          },
          required: ["payload", "rows"],
          additionalProperties: false,
        }),
      ],
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"write","arguments":{"payload":null,"rows":null}}</tool_call>',
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
      payload: null,
      rows: null,
    });
    expect(out.some((c) => c.type === "tool-input-start")).toBe(true);
    expect(out.some((c) => c.type === "tool-input-delta")).toBe(true);
    expect(out.some((c) => c.type === "tool-input-end")).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it("rejects non-object arguments for allOf-wrapped strict object input schemas", async () => {
    const argumentBodies = ["[]", '"scalar"'];
    for (const argumentBody of argumentBodies) {
      const onError = vi.fn();
      const protocol = hermesProtocol();
      const transformer = protocol.createStreamParser({
        tools: [
          makeSchemaTool("write", {
            allOf: [
              {
                type: "object",
                properties: {
                  content: { type: "string" },
                },
                required: ["content"],
                additionalProperties: false,
              },
            ],
          }),
        ],
        options: { onError },
      });
      const rs = new ReadableStream<LanguageModelV4StreamPart>({
        start(ctrl) {
          ctrl.enqueue({
            type: "text-delta",
            id: "1",
            delta: `<tool_call>{"name":"write","arguments":${argumentBody}}</tool_call>`,
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
    }
  });

  it("coerces keys before validating allOf-wrapped strict object schemas", async () => {
    const onError = vi.fn();
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools: [
        makeSchemaTool("translate", {
          allOf: [
            {
              type: "object",
              properties: {
                targetLanguage: { type: "string" },
              },
              required: ["targetLanguage"],
              additionalProperties: false,
            },
          ],
        }),
      ],
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"translate","arguments":{"target_language":"ko"}}</tool_call>',
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
      targetLanguage: "ko",
    });
    expect(onError).not.toHaveBeenCalled();
  });
});
