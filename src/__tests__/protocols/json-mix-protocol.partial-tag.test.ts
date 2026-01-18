import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";

import { jsonProtocol } from "../../core/protocols/json-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../test-helpers";

describe("jsonProtocol partial tag handling", () => {
  it("breaks inner loop when only partial start tag suffix present and publishes buffer", async () => {
    const protocol = jsonProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "before <tool_c" });
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
    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as any).delta)
      .join("");
    expect(text).toContain("before <tool_c");
    expect(out.some((c) => c.type === "tool-call")).toBe(false);
  });
});
