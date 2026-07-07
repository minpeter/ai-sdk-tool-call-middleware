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
    expect(typeof metadata?.toolCallId).toBe("string");
    expect((metadata?.toolCallId as string).length).toBeGreaterThan(0);
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
});
