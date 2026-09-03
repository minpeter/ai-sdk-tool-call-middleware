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

describe("json-repair.test split 10", () => {
  it("accepts values that match a primitive oneOf branch", async () => {
    const onError = vi.fn();
    const tools = [
      makeSchemaTool("edit", {
        type: "object",
        properties: {
          payload: {
            oneOf: [
              {
                type: "object",
                properties: { content: { type: "string" } },
                required: ["content"],
                additionalProperties: false,
              },
              { type: "string" },
            ],
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
            '<tool_call>{"name":"edit","arguments":{"payload":"abc"}}</tool_call>',
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
      payload: "abc",
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("accepts oneOf object branches distinguished by nested primitive value types", async () => {
    const onError = vi.fn();
    const tools = [
      makeSchemaTool("edit", {
        type: "object",
        properties: {
          payload: {
            oneOf: [
              {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: { value: { type: "number" } },
                required: ["value"],
                additionalProperties: false,
              },
            ],
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
            '<tool_call>{"name":"edit","arguments":{"payload":{"value":"abc"}}}</tool_call>',
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
      payload: { value: "abc" },
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not count numeric strings as numeric oneOf matches", async () => {
    const onError = vi.fn();
    const tools = [
      makeSchemaTool("edit", {
        type: "object",
        properties: {
          payload: {
            oneOf: [
              {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: { value: { type: "integer" } },
                required: ["value"],
                additionalProperties: false,
              },
            ],
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
            '<tool_call>{"name":"edit","arguments":{"payload":{"value":"123"}}}</tool_call>',
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
      payload: { value: "123" },
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("rejects non-finite numeric strings for number and integer schemas", async () => {
    const cases = [
      { schemaType: "number", value: "1e999" },
      { schemaType: "integer", value: "9".repeat(400) },
    ];
    for (const { schemaType, value } of cases) {
      const onError = vi.fn();
      const protocol = hermesProtocol();
      const transformer = protocol.createStreamParser({
        tools: [
          makeSchemaTool("edit", {
            type: "object",
            properties: {
              value: { type: schemaType },
            },
            required: ["value"],
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
            delta: `<tool_call>{"name":"edit","arguments":{"value":${JSON.stringify(value)}}}</tool_call>`,
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

  it("rejects decimal strings for integer oneOf branches", async () => {
    const onError = vi.fn();
    const tools = [
      makeSchemaTool("edit", {
        type: "object",
        properties: {
          payload: {
            oneOf: [
              {
                type: "object",
                properties: { value: { type: "integer" } },
                required: ["value"],
                additionalProperties: false,
              },
            ],
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
            '<tool_call>{"name":"edit","arguments":{"payload":{"value":"1.5"}}}</tool_call>',
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
