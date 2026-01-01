import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";

import { morphXmlProtocol } from "../../core/protocols/morph-xml-protocol";
import { stopFinishReason, zeroUsage } from "../test-helpers";

describe("morphXmlProtocol streaming trailing text-end on flush", () => {
  it("emits text-end when there is open text at flush with no tags", async () => {
    const protocol = morphXmlProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "hello" });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(rs.pipeThrough(transformer));
    const types = out.map((c) => c.type);
    expect(types).toContain("text-start");
    expect(types).toContain("text-delta");
    expect(types).toContain("text-end");
  });
});
