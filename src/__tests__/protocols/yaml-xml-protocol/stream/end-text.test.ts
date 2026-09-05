import { describe, expect, it } from "vitest";

import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import { stopFinishReason, zeroUsage } from "../../../test-helpers";
import { observeLifecycle } from "../../shared/duplicate-harness";

describe("yamlXmlProtocol streaming trailing text-end on flush", () => {
  it("emits text-end before finish when trailing plain text remains", async () => {
    const observation = await observeLifecycle({
      protocol: yamlXmlProtocol(),
      tools: [],
      parts: [
        { type: "text-delta", id: "1", delta: "hello" },
        { type: "finish", finishReason: stopFinishReason, usage: zeroUsage },
      ],
    });
    const types = observation.eventTypes;
    expect(types).toEqual(
      expect.arrayContaining(["text-start", "text-delta", "text-end"])
    );
    const deltaIndex = types.indexOf("text-delta");
    const endIndex = types.indexOf("text-end");
    const finishIndex = types.indexOf("finish");
    expect(endIndex).toBeGreaterThan(deltaIndex);
    expect(finishIndex).toBeGreaterThan(endIndex);
  });
});
