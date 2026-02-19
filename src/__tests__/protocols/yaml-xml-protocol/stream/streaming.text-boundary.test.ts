import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";
import { basicTools } from "../parse-generated-text/shared";

describe("yamlXmlProtocol text-start/text-end events", () => {
  it("should emit proper text-start and text-end events", async () => {
    const protocol = yamlXmlProtocol();
    const transformer = protocol.createStreamParser({ tools: basicTools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "Before " });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<get_location/>",
        });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: " After" });
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
    const eventTypes = out.map((e) => e.type);

    expect(eventTypes).toContain("text-start");
    expect(eventTypes).toContain("text-end");
    expect(eventTypes).toContain("tool-call");
  });
});
