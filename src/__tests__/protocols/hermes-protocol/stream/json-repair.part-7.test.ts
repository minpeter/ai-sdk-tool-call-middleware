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

describe("json-repair.test split 7", () => {
  it("drops nested schema-unknown argument keys", async () => {
    const onError = vi.fn();
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          payload: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        required: ["payload"],
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
            '<tool_call>{"name":"write","arguments":{"payload":{"value":"ok","secret":"blocked"}}}</tool_call>',
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
      payload: { value: "ok" },
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops nested argument keys disallowed by false schemas", async () => {
    const onError = vi.fn();
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          payload: {
            type: "object",
            properties: {
              secret: false,
              value: { type: "string" },
            },
            additionalProperties: true,
          },
        },
        required: ["payload"],
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
            '<tool_call>{"name":"write","arguments":{"payload":{"value":"ok","secret":"blocked"}}}</tool_call>',
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
      payload: { value: "ok" },
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("rejects top-level boolean false input schemas", async () => {
    const schemas: JSONValue[] = [false, { jsonSchema: false }];
    for (const inputSchema of schemas) {
      const onError = vi.fn();
      const protocol = hermesProtocol();
      const transformer = protocol.createStreamParser({
        tools: [makeSchemaTool("deny", inputSchema)],
        options: { onError },
      });
      const rs = new ReadableStream<LanguageModelV4StreamPart>({
        start(ctrl) {
          ctrl.enqueue({
            type: "text-delta",
            id: "1",
            delta:
              '<tool_call>{"name":"deny","arguments":{"content":"ok"}}</tool_call>',
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

  it("rejects non-object arguments for top-level boolean false input schemas", async () => {
    const schemas: JSONValue[] = [false, { jsonSchema: false }];
    const argumentBodies = ["[]", "null", '"x"'];

    for (const inputSchema of schemas) {
      for (const argumentBody of argumentBodies) {
        const onError = vi.fn();
        const protocol = hermesProtocol();
        const transformer = protocol.createStreamParser({
          tools: [makeSchemaTool("deny", inputSchema)],
          options: { onError },
        });
        const rs = new ReadableStream<LanguageModelV4StreamPart>({
          start(ctrl) {
            ctrl.enqueue({
              type: "text-delta",
              id: "1",
              delta: `<tool_call>{"name":"deny","arguments":${argumentBody}}</tool_call>`,
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
    }
  });

  it("rejects non-object arguments for object input schemas", async () => {
    const argumentBodies = ["[]", "null", '"x"'];
    const schemas: JSONValue[] = [
      {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        required: ["content"],
      },
      {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        required: ["content"],
        additionalProperties: false,
      },
    ];
    for (const inputSchema of schemas) {
      for (const argumentBody of argumentBodies) {
        const onError = vi.fn();
        const protocol = hermesProtocol();
        const transformer = protocol.createStreamParser({
          tools: [makeSchemaTool("write", inputSchema)],
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
    }
  });

  it("accepts omitted arguments for no-input tool calls", async () => {
    const onError = vi.fn();
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools: [
        makeSchemaTool("ping", {
          type: "object",
          properties: {},
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
          delta: '<tool_call>{"name":"ping"}</tool_call>',
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
});
