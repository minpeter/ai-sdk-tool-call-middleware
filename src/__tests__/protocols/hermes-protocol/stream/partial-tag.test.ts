import { describe, expect, it } from "vitest";

import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import {
  collectTextDeltas,
  runProtocolTextStream,
  selectToolCalls,
} from "../../shared/duplicate-harness";

describe("hermesProtocol partial tag handling", () => {
  it("breaks inner loop when only partial start tag suffix present and publishes buffer", async () => {
    const out = await runProtocolTextStream({
      protocol: hermesProtocol(),
      tools: [],
      chunks: ["before <tool_c"],
      id: "1",
    });
    const text = collectTextDeltas(out);
    expect(text).toContain("before <tool_c");
    expect(out.some((part) => part.type === "tool-call")).toBe(false);
  });

  it("keeps the longest overlapping start-tag suffix across chunks", async () => {
    const toolCallStart = "ababax";
    const toolCallEnd = "ENDTAG";
    const out = await runProtocolTextStream({
      protocol: hermesProtocol({ toolCallStart, toolCallEnd }),
      tools: [],
      chunks: [
        "before|ababa",
        `x{"name":"t","arguments":{"value":1}}${toolCallEnd}|after`,
      ],
      id: "1",
    });
    const text = collectTextDeltas(out);
    expect(text).toBe("before||after");
    expect(text).not.toContain("ababa");
    expect(text).not.toContain(toolCallStart);
    const toolCalls = selectToolCalls(out);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      type: "tool-call",
      toolName: "t",
      input: '{"value":1}',
    });
  });
});
