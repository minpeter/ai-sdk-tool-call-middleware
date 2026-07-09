import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";

describe("qwen3CoderProtocol streaming onError metadata", () => {
  const bookFlightTool = {
    type: "function" as const,
    name: "book_flight",
    inputSchema: {
      type: "object",
      properties: {
        cabin: { type: "string" },
      },
    },
  } satisfies LanguageModelV4FunctionTool;
  const prototypeSensitiveParameterNames = [
    "__proto__",
    "constructor",
    "prototype",
  ] as const;

  it("populates unresolved-tool-name dropReason with toolCallId when streaming tool name cannot be resolved", async () => {
    const onError = vi.fn();
    const protocol = qwen3CoderProtocol();
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
            "<tool_call><function><parameter=x>1</parameter></function></tool_call>",
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    await convertReadableStreamToArray(pipeWithTransformer(rs, transformer));

    const resolveFail = onError.mock.calls.find(([message]) =>
      String(message).includes(
        "Could not resolve Qwen3CoderToolParser tool name"
      )
    );
    expect(resolveFail).toBeDefined();
    const metadata = resolveFail?.[1];
    expect(metadata).toMatchObject({
      dropReason: "unresolved-tool-name",
    });
    const toolCallId = metadata?.toolCallId;
    expect(typeof toolCallId).toBe("string");
    expect((toolCallId as string).length).toBeGreaterThan(0);
  });

  it.each(
    prototypeSensitiveParameterNames
  )("drops wrapperless partial prototype-sensitive arg trailing text for %s", async (parameterName) => {
    const onError = vi.fn();
    const protocol = qwen3CoderProtocol();
    const transformer = protocol.createStreamParser({
      tools: [bookFlightTool],
      options: { emitRawToolCallTextOnError: true, onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: `<function=book_flight><parameter=${parameterName}`,
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

    expect(out.find((part) => part.type === "tool-call")).toMatchObject({
      type: "tool-call",
      toolName: "book_flight",
      input: "{}",
    });
    expect(
      out
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join("")
    ).toBe("");
    expect(onError).toHaveBeenCalled();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain(parameterName);
    expect(metadataText).not.toContain("<parameter=");
  });

  it("redacts prototype-sensitive streaming stringify errors in metadata", async () => {
    const onError = vi.fn();
    const protocol = qwen3CoderProtocol();
    const transformer = protocol.createStreamParser({
      tools: [bookFlightTool],
      options: { emitRawToolCallTextOnError: true, onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call><function=book_flight><parameter=constructor>{"polluted":true}</parameter></function></tool_call>',
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });

    await convertReadableStreamToArray(pipeWithTransformer(rs, transformer));

    expect(onError).toHaveBeenCalled();
    const metadata = onError.mock.calls[0]?.[1] as
      | { error?: unknown }
      | undefined;
    expect(metadata?.error).toBe("[redacted sensitive tool call]");
  });

  it.each(
    prototypeSensitiveParameterNames
  )("drops standalone prototype-sensitive parameter trailing text after wrapperless call for %s", async (parameterName) => {
    const onError = vi.fn();
    const protocol = qwen3CoderProtocol();
    const transformer = protocol.createStreamParser({
      tools: [bookFlightTool],
      options: { emitRawToolCallTextOnError: true, onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            "<function=book_flight><parameter=cabin>economy</parameter></function>" +
            `<parameter=${parameterName}>{"polluted":true}</parameter>`,
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

    expect(out.find((part) => part.type === "tool-call")).toMatchObject({
      type: "tool-call",
      toolName: "book_flight",
      input: '{"cabin":"economy"}',
    });
    expect(
      out
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join("")
    ).toBe("");
    expect(onError).toHaveBeenCalled();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain(parameterName);
    expect(metadataText).not.toContain("<parameter=");
  });

  it.each(
    prototypeSensitiveParameterNames
  )("preserves safe text after dropped standalone prototype-sensitive parameter trailing text for %s", async (parameterName) => {
    const onError = vi.fn();
    const protocol = qwen3CoderProtocol();
    const transformer = protocol.createStreamParser({
      tools: [bookFlightTool],
      options: { emitRawToolCallTextOnError: true, onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            "<function=book_flight><parameter=cabin>economy</parameter></function>" +
            `<parameter=${parameterName}>{"polluted":true}</parameter> after`,
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

    expect(out.find((part) => part.type === "tool-call")).toMatchObject({
      type: "tool-call",
      toolName: "book_flight",
      input: '{"cabin":"economy"}',
    });
    expect(
      out
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join("")
    ).toBe(" after");
    expect(onError).toHaveBeenCalled();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain(parameterName);
    expect(metadataText).not.toContain("<parameter=");
  });

  it("preserves safe text after dropped entity-encoded standalone prototype-sensitive parameter trailing text", async () => {
    const onError = vi.fn();
    const protocol = qwen3CoderProtocol();
    const transformer = protocol.createStreamParser({
      tools: [bookFlightTool],
      options: { emitRawToolCallTextOnError: true, onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            "<function=book_flight><parameter=cabin>economy</parameter></function>" +
            '<parameter name="&#99;onstructor">{"polluted":true}</parameter> after',
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

    expect(out.find((part) => part.type === "tool-call")).toMatchObject({
      type: "tool-call",
      toolName: "book_flight",
      input: '{"cabin":"economy"}',
    });
    expect(
      out
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join("")
    ).toBe(" after");
    expect(onError).toHaveBeenCalled();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain("polluted");
    expect(metadataText).not.toContain("&#99;onstructor");
  });

  it("preserves safe text after dropped unquoted-name standalone prototype-sensitive parameter trailing text", async () => {
    const onError = vi.fn();
    const protocol = qwen3CoderProtocol();
    const transformer = protocol.createStreamParser({
      tools: [bookFlightTool],
      options: { emitRawToolCallTextOnError: true, onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            "<function=book_flight><parameter=cabin>economy</parameter></function>" +
            '<parameter name=constructor>{"polluted":true}</parameter> after',
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

    expect(out.find((part) => part.type === "tool-call")).toMatchObject({
      type: "tool-call",
      toolName: "book_flight",
      input: '{"cabin":"economy"}',
    });
    expect(
      out
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join("")
    ).toBe(" after");
    expect(onError).toHaveBeenCalled();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain("polluted");
    expect(metadataText).not.toContain("name=constructor");
  });

  it("preserves ordinary prose that mentions constructor as a label", async () => {
    const onError = vi.fn();
    const protocol = qwen3CoderProtocol();
    const transformer = protocol.createStreamParser({
      tools: [],
      options: { emitRawToolCallTextOnError: true, onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "constructor: ordinary prose",
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

    expect(
      out
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join("")
    ).toBe("constructor: ordinary prose");
    expect(onError).not.toHaveBeenCalled();
  });
});
