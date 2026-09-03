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
type TextDeltaPart = Extract<LanguageModelV4StreamPart, { type: "text-delta" }>;

function isToolCallPart(part: LanguageModelV4StreamPart): part is ToolCallPart {
  return part.type === "tool-call";
}

function isTextDeltaPart(
  part: LanguageModelV4StreamPart
): part is TextDeltaPart {
  return part.type === "text-delta";
}

describe("json-repair.test split 2", () => {
  it("drops schema-unknown keys for jsonSchema-wrapped strict schemas", async () => {
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
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
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
    const tool = out.find(isToolCallPart);
    expect(tool?.toolName).toBe("write");
    expect(JSON.parse(tool?.input ?? "{}")).toEqual({
      content: "ok",
      path: "/tmp/a",
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops schema-unknown keys for clean strict JSON", async () => {
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
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
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
    const tool = out.find(isToolCallPart);
    expect(tool?.toolName).toBe("write");
    expect(JSON.parse(tool?.input ?? "{}")).toEqual({
      content: "ok",
      path: "/tmp/a",
    });
    expect(onError).not.toHaveBeenCalled();
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
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
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
    const metadata = onError.mock.calls[0]?.[1] as
      | { readonly error?: JSONValue }
      | undefined;
    expect(metadata?.error).toBe("[redacted sensitive tool call]");
  });

  it("drops double-encoded unicode prototype-sensitive keys without raw fallback text", async () => {
    const onError = vi.fn();
    const argumentsText =
      '{"\\\\u0063onstructor":{"polluted":true},"content":"ok"}';
    const text = `<tool_call>${JSON.stringify({
      name: "write",
      arguments: argumentsText,
    })}</tool_call>`;
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
      options: { emitRawToolCallTextOnError: true, onError },
    });
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

    expect(out.find((c) => c.type === "tool-call")).toBeUndefined();
    expect(
      out
        .filter(isTextDeltaPart)
        .map((part) => part.delta)
        .join("")
    ).not.toContain("<tool_call>");
    expect(
      out
        .filter(isTextDeltaPart)
        .map((part) => part.delta)
        .join("")
    ).not.toContain("\\u0063onstructor");
    expect(onError).toHaveBeenCalled();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain("\\u0063onstructor");
  });

  it("rejects prototype-sensitive non-object string arguments", async () => {
    const onError = vi.fn();
    const text =
      '<tool_call>{"name":"echo","arguments":"<prototype>x</prototype>"}</tool_call>';
    const tools = [makeSchemaTool("echo", { type: "string" })];
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools,
      options: { emitRawToolCallTextOnError: true, onError },
    });
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

    expect(out.find((c) => c.type === "tool-call")).toBeUndefined();
    expect(
      out
        .filter(isTextDeltaPart)
        .map((part) => part.delta)
        .join("")
    ).toBe("");
    expect(onError).toHaveBeenCalled();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain("<prototype>");
  });

  it("coerces top-level primitive string arguments by schema", async () => {
    const text = '<tool_call>{"name":"count","arguments":"42"}</tool_call>';
    const tools = [makeSchemaTool("count", { type: "number" })];
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

    expect(tool?.toolName).toBe("count");
    expect(tool?.input).toBe("42");
    expect(
      out
        .filter((part) => part.type === "tool-input-delta")
        .map((part) => part.delta)
        .join("")
    ).toBe("42");
  });
});
