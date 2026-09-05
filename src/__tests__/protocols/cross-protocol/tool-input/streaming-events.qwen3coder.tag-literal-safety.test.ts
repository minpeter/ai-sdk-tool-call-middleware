import { describe, expect, it } from "vitest";

import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import {
  collectTextDeltas,
  observeObjectDeltas,
  parseToolCallObject,
  runProtocolTextStream,
  selectToolCalls,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";

const protocol = qwen3CoderProtocol();

async function expectAlphaQuery(
  chunks: readonly string[],
  query: string
): Promise<void> {
  const observation = await observeObjectDeltas({
    chunks,
    id: "fixture",
    protocol,
    tools: [],
  });

  expect(observation.toolCall).toBeTruthy();
  expect(observation.toolCall.toolName).toBe("alpha");
  expect(parseToolCallObject(observation.toolCall)).toEqual({ query });
}

describe("cross-protocol tool-input streaming events: qwen3coder", () => {
  it("Qwen3CoderToolParser does not truncate parameter values containing </toolbox> pseudo-tags", async () => {
    await expectAlphaQuery(
      [
        "<tool_call><function=alpha><parameter=query>How to close </toolbox> tag</function></tool_call>",
      ],
      "How to close </toolbox> tag"
    );
  });

  it("Qwen3CoderToolParser keeps </tool> text when parsing a <function> call", async () => {
    await expectAlphaQuery(
      [
        "<tool_call><function=alpha><parameter=query>How to use </tool> tag</function></tool_call>",
      ],
      "How to use </tool> tag"
    );
  });

  it("Qwen3CoderToolParser does not treat chunk-terminal </call prefix as a completed boundary", async () => {
    await expectAlphaQuery(
      [
        "<tool_call><call=alpha><parameter=query>How to use </call",
        "out> tag</call></tool_call>",
      ],
      "How to use </callout> tag"
    );
  });

  it("Qwen3CoderToolParser keeps implicit-call-like tags without tool identifier as text", async () => {
    const input = "before <function>docs</function> after";
    const out = await runProtocolTextStream({
      chunks: ["before <function>docs", "</function> after"],
      id: "fixture",
      protocol,
      tools: [],
    });

    const textOut = collectTextDeltas(out);
    const { starts, deltas, ends } = selectToolInputTimeline(out);

    expect(selectToolCalls(out)).toHaveLength(0);
    expect(starts).toHaveLength(0);
    expect(deltas).toHaveLength(0);
    expect(ends).toHaveLength(0);
    expect(textOut).toBe(input);
  });
});
