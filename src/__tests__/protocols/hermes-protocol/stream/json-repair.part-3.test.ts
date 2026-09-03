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

describe("json-repair.test split 3", () => {
  it.each([
    "constructor: ordinary prose",
    "prototype: ordinary prose",
    "constructor: true",
  ] as const)(
    "preserves schema-valid string argument value %s",
    async (note) => {
      const text = `<tool_call>${JSON.stringify({
        name: "write",
        arguments: { note },
      })}</tool_call>`;
      const tools = [
        makeSchemaTool("write", {
          type: "object",
          properties: {
            note: { type: "string" },
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
            delta: text,
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

      expect(tool?.toolName).toBe("write");
      expect(tool?.input).toBe(JSON.stringify({ note }));
      expect(
        out
          .filter((part) => part.type === "tool-input-delta")
          .map((part) => part.delta)
          .join("")
      ).toBe(JSON.stringify({ note }));
    }
  );

  it("rejects unquoted strict RJSON with prototype-sensitive argument keys", async () => {
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
            '<tool_call>{name:"write",arguments:{__proto__:{polluted:true},content:"ok"}}</tool_call>',
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

  it("rejects unquoted prototype-sensitive RJSON keys after comments", async () => {
    const tools = [makeTool("write", { content: { type: "string" } }, false)];
    for (const prefix of ["/* comment */", "// comment\n"]) {
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
            delta: `<tool_call>{name:"write",arguments:{${prefix}__proto__:{polluted:true},content:"ok"}}</tool_call>`,
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

  it("rejects prototype-sensitive RJSON keys after leading comments", async () => {
    const onError = vi.fn();
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools: [makeTool("write", { content: { type: "string" } }, true)],
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>/*{}*/{name:"write",arguments:{__proto__:{polluted:true},content:"ok"}}</tool_call>',
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

  it("rejects prototype-sensitive argument keys even when unknown keys are allowed", async () => {
    const onError = vi.fn();
    const tools = [
      makeTool(
        "write",
        {
          content: { type: "string" },
        },
        true
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
            '<tool_call>{"name":"write","arguments":{"content":"ok","constructor":{"polluted":true}}}</tool_call>',
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

  it("rejects escaped single-quoted strict RJSON prototype-sensitive argument keys", async () => {
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
            '<tool_call>{name:"write",arguments:{\'\\u005f\\u005fproto__\':{polluted:true},content:"ok"}}</tool_call>',
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

  it("accepts coercible keys before strict schema validation", async () => {
    const tools = [
      makeSchemaTool("translate", {
        type: "object",
        properties: {
          text: { type: "string" },
          targetLanguage: { type: "string" },
          formality: { type: "string" },
        },
        required: ["text", "targetLanguage", "formality"],
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
            '<tool_call>{"name":"translate","arguments":{"text":"Ship","target_language":"fr","formality":"casual"}}</tool_call>',
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
    expect(JSON.parse(tool.input)).toEqual({
      text: "Ship",
      targetLanguage: "fr",
      formality: "casual",
    });
  });
});
