import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";

describe("qwen3CoderProtocol streaming onError metadata", () => {
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
});
