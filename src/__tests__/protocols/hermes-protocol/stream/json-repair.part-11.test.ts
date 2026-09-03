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

describe("json-repair.test split 11", () => {
  it("accepts oneOf object branches distinguished by nested enum values", async () => {
    const tools = [
      makeSchemaTool("edit", {
        type: "object",
        properties: {
          payload: {
            oneOf: [
              {
                type: "object",
                properties: { value: { type: "string", enum: ["a"] } },
                required: ["value"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: { value: { type: "string", enum: ["b"] } },
                required: ["value"],
                additionalProperties: false,
              },
            ],
          },
        },
        additionalProperties: false,
      }),
    ];
    for (const value of ["a", "b"]) {
      const onError = vi.fn();
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
            delta: `<tool_call>{"name":"edit","arguments":{"payload":{"value":"${value}"}}}</tool_call>`,
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
      expect(
        tool?.type === "tool-call" ? JSON.parse(tool.input) : null
      ).toEqual({
        payload: { value },
      });
      expect(out.some((c) => c.type === "tool-input-start")).toBe(true);
      expect(out.some((c) => c.type === "tool-input-delta")).toBe(true);
      expect(out.some((c) => c.type === "tool-input-end")).toBe(true);
      expect(onError).not.toHaveBeenCalled();
    }
  });

  it("accepts oneOf object branches distinguished by nested const values", async () => {
    const tools = [
      makeSchemaTool("edit", {
        type: "object",
        properties: {
          payload: {
            oneOf: [
              {
                type: "object",
                properties: {
                  kind: { const: "text" },
                  value: { type: "string" },
                },
                required: ["kind", "value"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  kind: { const: "count" },
                  value: { type: "integer" },
                },
                required: ["kind", "value"],
                additionalProperties: false,
              },
            ],
          },
        },
        additionalProperties: false,
      }),
    ];
    for (const [kind, value] of [
      ["text", '"hello"'],
      ["count", "3"],
    ]) {
      const onError = vi.fn();
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
            delta: `<tool_call>{"name":"edit","arguments":{"payload":{"kind":"${kind}","value":${value}}}}</tool_call>`,
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
      expect(out.some((c) => c.type === "tool-input-start")).toBe(true);
      expect(out.some((c) => c.type === "tool-input-delta")).toBe(true);
      expect(out.some((c) => c.type === "tool-input-end")).toBe(true);
      expect(onError).not.toHaveBeenCalled();
    }
  });

  it("rejects oneOf object branches with mismatched const values", async () => {
    const onError = vi.fn();
    const tools = [
      makeSchemaTool("edit", {
        type: "object",
        properties: {
          payload: {
            oneOf: [
              {
                type: "object",
                properties: {
                  kind: { const: "text" },
                  value: { type: "string" },
                },
                required: ["kind", "value"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  kind: { const: "count" },
                  value: { type: "integer" },
                },
                required: ["kind", "value"],
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
            '<tool_call>{"name":"edit","arguments":{"payload":{"kind":"count","value":"hello"}}}</tool_call>',
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

  it("drops object keys not declared by primitive oneOf branches", async () => {
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
            '<tool_call>{"name":"edit","arguments":{"payload":{"content":"ok","extra":"bad"}}}</tool_call>',
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
      payload: { content: "ok" },
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops stray keys before validating top-level anyOf branches", async () => {
    const onError = vi.fn();
    const tools = [
      makeSchemaTool("edit", {
        anyOf: [
          {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { latitude: { type: "number" } },
            required: ["latitude"],
            additionalProperties: false,
          },
        ],
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
            '<tool_call>{"name":"edit","arguments":{"city":"Seoul","stray":"drop"}}</tool_call>',
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
      city: "Seoul",
    });
    expect(onError).not.toHaveBeenCalled();
  });
});
