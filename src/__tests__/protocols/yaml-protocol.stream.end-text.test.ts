import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";

import { yamlProtocol } from "../../core/protocols/yaml-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../test-helpers";

describe("yamlProtocol streaming trailing text-end on flush", () => {
  it("emits text-end before finish when trailing plain text remains", async () => {
    const protocol = yamlProtocol();
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

    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const types = out.map((c) => c.type);

    expect(types).toContain("text-start");
    expect(types).toContain("text-delta");
    expect(types).toContain("text-end");
    expect(types.indexOf("text-end")).toBeGreaterThan(
      types.indexOf("text-delta")
    );
    expect(types.indexOf("finish")).toBeGreaterThan(types.indexOf("text-end"));
  });
});
