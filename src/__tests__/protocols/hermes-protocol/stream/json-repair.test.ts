import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
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
  properties: Record<string, { type: string }>,
  additionalProperties?: boolean
): LanguageModelV3FunctionTool {
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

function makeSchemaTool(
  name: string,
  inputSchema: LanguageModelV3FunctionTool["inputSchema"]
): LanguageModelV3FunctionTool {
  return { type: "function", name, inputSchema };
}

describe("hermesProtocol streaming JSON repair", () => {
  it("repairs streaming tool call with unescaped quotes and emits tool-call", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"edit","arguments":{"content":"He said "hello" to me"}}</tool_call>',
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
    expect(tool.toolName).toBe("edit");
    const args = JSON.parse(tool.input);
    expect(args.content).toBe('He said "hello" to me');
    // Should not emit any text-delta with raw tool call markup
    const textDeltas = out
      .filter((c) => c.type === "text-delta")
      .map((c: any) => c.delta)
      .join("");
    expect(textDeltas).not.toContain("<tool_call>");
  });

  it("repairs streaming unescaped quotes before a right brace character", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools: [makeTool("edit", { content: { type: "string" } }, false)],
    });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"edit","arguments":{"content":"He said "}" there"}}</tool_call>',
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
    if (tool?.type !== "tool-call") {
      throw new Error("Expected repaired tool call");
    }
    expect(JSON.parse(tool.input)).toEqual({ content: 'He said "}" there' });
  });

  it("repairs with known tool schema (tools parameter provided)", async () => {
    const tools = [
      makeTool("write", {
        path: { type: "string" },
        content: { type: "string" },
      }),
    ];
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<tool_call>",
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '{"name":"write","arguments":{"path":"/tmp/test.js","content":"var x = "hello";',
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '"}}',
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "</tool_call>",
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
    expect(tool.toolName).toBe("write");
    const args = JSON.parse(tool.input);
    expect(args.path).toBe("/tmp/test.js");
    expect(args.content).toContain('"hello"');
  });

  it("calls onError for schema-unknown keys when additionalProperties is false", async () => {
    const onError = vi.fn();
    const tools = [
      makeTool(
        "write",
        {
          path: { type: "string" },
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"write","arguments":{"content":"He said "hi" there","debug":"drop me","path":"/tmp/a"}}</tool_call>',
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
    expect(onError).toHaveBeenCalled();
  });

  it("rejects schema-unknown keys in strict repair even when arguments parse cleanly", async () => {
    const onError = vi.fn();
    const tools = [
      makeTool(
        "write",
        {
          path: { type: "string" },
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"write","arguments":{"content":"ok","debug":"drop me","path":"/tmp/a"}}}</tool_call>',
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
    expect(onError).toHaveBeenCalled();
  });

  it("rejects schema-unknown keys for jsonSchema-wrapped strict schemas", async () => {
    const onError = vi.fn();
    const tools = [
      makeSchemaTool("write", {
        jsonSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          additionalProperties: false,
        },
      }),
    ];
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"write","arguments":{"content":"ok","debug":"drop me","path":"/tmp/a"}}}</tool_call>',
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
    expect(onError).toHaveBeenCalled();
  });

  it("rejects clean strict JSON without leaking tool-input lifecycle events", async () => {
    const onError = vi.fn();
    const tools = [
      makeTool(
        "write",
        {
          path: { type: "string" },
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"write","arguments":{"content":"ok","debug":"drop me","path":"/tmp/a"}}</tool_call>',
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

  it("rejects clean strict JSON with prototype-sensitive argument keys", async () => {
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"write","arguments":{"content":"ok","__proto__":{"polluted":true}}}</tool_call>',
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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
      const rs = new ReadableStream<LanguageModelV3StreamPart>({
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            "<tool_call>{name:\"write\",arguments:{'\\u005f\\u005fproto__':{polluted:true},content:\"ok\"}}</tool_call>",
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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

  it("rejects inherited tool call fields from __proto__ wrappers", async () => {
    const onError = vi.fn();
    const tools = [makeTool("write", { content: { type: "string" } })];
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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

  it("accepts common grouped and quantified patternProperties for strict schemas", async () => {
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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
    expect(args["x-debug"]).toBe("kept");
    expect(args["y-trace"]).toBe("yes");
    expect(args["z-123"]).toBe("num");
  });

  it("rejects patternProperties false matches for strict schemas", async () => {
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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
    expect(out.find((c) => c.type === "tool-call")).toBeUndefined();
    expect(out.some((c) => c.type === "tool-input-start")).toBe(false);
    expect(out.some((c) => c.type === "tool-input-delta")).toBe(false);
    expect(out.some((c) => c.type === "tool-input-end")).toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  it("rejects false property schemas for strict schemas", async () => {
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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
    expect(out.find((c) => c.type === "tool-call")).toBeUndefined();
    expect(out.some((c) => c.type === "tool-input-start")).toBe(false);
    expect(out.some((c) => c.type === "tool-input-delta")).toBe(false);
    expect(out.some((c) => c.type === "tool-input-end")).toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  it("fails closed for unsafe patternProperties without leaking tool-input events", async () => {
    const onError = vi.fn();
    const slowKey = `${"a".repeat(24)}!`;
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        patternProperties: {
          "^(a+)+$": { type: "string" },
        },
        additionalProperties: false,
      }),
    ];
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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
    const started = performance.now();
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    expect(performance.now() - started).toBeLessThan(150);
    expect(out.find((c) => c.type === "tool-call")).toBeUndefined();
    expect(out.some((c) => c.type === "tool-input-start")).toBe(false);
    expect(out.some((c) => c.type === "tool-input-delta")).toBe(false);
    expect(out.some((c) => c.type === "tool-input-end")).toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  it("fails closed for unsafe false patternProperties when unknown keys are allowed", async () => {
    const onError = vi.fn();
    const slowKey = `${"a".repeat(24)}!`;
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        patternProperties: {
          "^(a+)+$": false,
        },
        additionalProperties: true,
      }),
    ];
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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
    const started = performance.now();
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    expect(performance.now() - started).toBeLessThan(150);
    expect(out.find((c) => c.type === "tool-call")).toBeUndefined();
    expect(out.some((c) => c.type === "tool-input-start")).toBe(false);
    expect(out.some((c) => c.type === "tool-input-delta")).toBe(false);
    expect(out.some((c) => c.type === "tool-input-end")).toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  it("fails closed for unsafe false patternProperties with character classes", async () => {
    const onError = vi.fn();
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        patternProperties: {
          "^(a|[0-9])+$": false,
        },
        additionalProperties: true,
      }),
    ];
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"write","arguments":{"content":"ok","123":"blocked"}}</tool_call>',
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    const started = performance.now();
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    expect(performance.now() - started).toBeLessThan(150);
    expect(out.find((c) => c.type === "tool-call")).toBeUndefined();
    expect(out.some((c) => c.type === "tool-input-start")).toBe(false);
    expect(out.some((c) => c.type === "tool-input-delta")).toBe(false);
    expect(out.some((c) => c.type === "tool-input-end")).toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  it("fails closed for unsafe false patternProperties with escaped literals", async () => {
    const onError = vi.fn();
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        patternProperties: {
          "^(\\x61+)+$": false,
        },
        additionalProperties: true,
      }),
    ];
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"write","arguments":{"content":"ok","aaaa":"blocked"}}</tool_call>',
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

  it("fails closed for unsafe false patternProperties with unknown matchers", async () => {
    const onError = vi.fn();
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        patternProperties: {
          "^([^\\n]+)+$": false,
        },
        additionalProperties: true,
      }),
    ];
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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
    expect(out.find((c) => c.type === "tool-call")).toBeUndefined();
    expect(out.some((c) => c.type === "tool-input-start")).toBe(false);
    expect(out.some((c) => c.type === "tool-input-delta")).toBe(false);
    expect(out.some((c) => c.type === "tool-input-end")).toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  it("preserves allowed keys when an unsafe false pattern contains character classes", async () => {
    const onError = vi.fn();
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        patternProperties: {
          "^(a|[0-9])+$": false,
        },
        additionalProperties: true,
      }),
    ];
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"write","arguments":{"content":"ok","note":"safe"}}</tool_call>',
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
      note: "safe",
    });
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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
    const started = performance.now();
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    expect(performance.now() - started).toBeLessThan(150);
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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

  it("rejects nested schema-unknown argument keys", async () => {
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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
    expect(out.find((c) => c.type === "tool-call")).toBeUndefined();
    expect(out.some((c) => c.type === "tool-input-start")).toBe(false);
    expect(out.some((c) => c.type === "tool-input-delta")).toBe(false);
    expect(out.some((c) => c.type === "tool-input-end")).toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  it("rejects nested argument keys disallowed by false schemas", async () => {
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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
    expect(out.find((c) => c.type === "tool-call")).toBeUndefined();
    expect(out.some((c) => c.type === "tool-input-start")).toBe(false);
    expect(out.some((c) => c.type === "tool-input-delta")).toBe(false);
    expect(out.some((c) => c.type === "tool-input-end")).toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  it("rejects top-level boolean false input schemas", async () => {
    const schemas: LanguageModelV3FunctionTool["inputSchema"][] = [
      false,
      { jsonSchema: false },
    ];
    for (const inputSchema of schemas) {
      const onError = vi.fn();
      const protocol = hermesProtocol();
      const transformer = protocol.createStreamParser({
        tools: [makeSchemaTool("deny", inputSchema)],
        options: { onError },
      });
      const rs = new ReadableStream<LanguageModelV3StreamPart>({
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

  it("rejects unknown keys through strict allOf schemas", async () => {
    const onError = vi.fn();
    const tools = [
      makeSchemaTool("write", {
        allOf: [
          {
            type: "object",
            properties: {
              safe: { type: "string" },
            },
            required: ["safe"],
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"write","arguments":{"safe":"ok","secret":"leak"}}</tool_call>',
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

  it("rejects nested array item keys through allOf schemas", async () => {
    const onError = vi.fn();
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          payload: {
            allOf: [
              {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    value: { type: "string" },
                  },
                  additionalProperties: false,
                },
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"write","arguments":{"payload":[{"value":"ok","secret":"leak"}]}}</tool_call>',
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

  it("applies every matching property and pattern schema", async () => {
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
        patternProperties: {
          "^payload$": {
            type: "object",
            properties: {
              must: { type: "string" },
            },
            required: ["must"],
            additionalProperties: false,
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"edit","arguments":{"payload":{"other":"bad"}}}</tool_call>',
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

  it("preserves allowed extra argument keys when a denied pattern is unsafe", async () => {
    const onError = vi.fn();
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        patternProperties: {
          "^(a+)+$": false,
        },
        additionalProperties: true,
      }),
    ];
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"write","arguments":{"content":"ok","note":"safe"}}</tool_call>',
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
      note: "safe",
    });
    expect(out.some((c) => c.type === "tool-input-start")).toBe(true);
    expect(out.some((c) => c.type === "tool-input-delta")).toBe(true);
    expect(out.some((c) => c.type === "tool-input-end")).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not leak tool-input events when a later chunk invalidates a complete arguments object", async () => {
    const onError = vi.fn();
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools: [],
      options: { onError },
    });
    const input = new TransformStream<
      LanguageModelV3StreamPart,
      LanguageModelV3StreamPart
    >();
    const out: LanguageModelV3StreamPart[] = [];
    const done = input.readable.pipeThrough(transformer).pipeTo(
      new WritableStream<LanguageModelV3StreamPart>({
        write(part) {
          out.push(part);
        },
      })
    );
    const writer = input.writable.getWriter();

    await writer.write({
      type: "text-delta",
      id: "1",
      delta: '<tool_call>{"name":"edit","arguments":{"content":"ok"}}',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await writer.write({
      type: "text-delta",
      id: "1",
      delta: ',"dangling":</tool_call>',
    });
    await writer.write({
      type: "finish",
      finishReason: stopFinishReason,
      usage: zeroUsage,
    });
    await writer.close();
    await done;

    const tool = out.find((c) => c.type === "tool-call");
    expect(tool).toBeTruthy();
    expect(tool?.type === "tool-call" ? JSON.parse(tool.input) : null).toEqual({
      content: "ok",
    });
    expect(out.some((c) => c.type === "tool-input-start")).toBe(true);
    expect(out.some((c) => c.type === "tool-input-delta")).toBe(true);
    expect(out.some((c) => c.type === "tool-input-end")).toBe(true);
    expect(onError).toHaveBeenCalled();
  });
});
