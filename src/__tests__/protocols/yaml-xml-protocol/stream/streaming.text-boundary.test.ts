import { describe, expect, it } from "vitest";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import { stopFinishReason, zeroUsage } from "../../../test-helpers";
import { observeLifecycle } from "../../shared/duplicate-harness";
import { basicTools } from "../parse-generated-text/shared";

describe("yamlXmlProtocol text-start/text-end events", () => {
  it("should emit proper text-start and text-end events", async () => {
    const observation = await observeLifecycle({
      protocol: yamlXmlProtocol(),
      tools: basicTools,
      parts: [
        { type: "text-delta", id: "1", delta: "Before " },
        { type: "text-delta", id: "1", delta: "<get_location/>" },
        { type: "text-delta", id: "1", delta: " After" },
        { type: "finish", finishReason: stopFinishReason, usage: zeroUsage },
      ],
    });
    expect(observation.eventTypes).toEqual(
      expect.arrayContaining(["text-start", "text-end", "tool-call"])
    );
  });
});
