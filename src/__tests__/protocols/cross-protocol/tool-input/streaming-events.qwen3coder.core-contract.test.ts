import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { toolInputStreamFixtures } from "../../../fixtures/tool-input-stream-fixtures";
import {
  collectTextDeltas,
  requireToolCall,
  runStreamingEventCase,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";
import {
  assertCanonicalAiSdkEventOrder,
  assertCoreAiSdkEventCoverage,
} from "./streaming-events.shared";

function expectReconciledCall(
  out: readonly LanguageModelV4StreamPart[],
  expectedToolName: string
) {
  const timeline = selectToolInputTimeline(out);
  const toolCall = requireToolCall(out);
  expect(timeline.starts).toHaveLength(1);
  expect(timeline.deltas.length).toBeGreaterThan(0);
  expect(timeline.ends).toHaveLength(1);
  expect(timeline.starts[0]?.id).toBe(timeline.ends[0]?.id);
  expect(toolCall.toolCallId).toBe(timeline.starts[0]?.id);
  expect(toolCall.toolName).toBe(expectedToolName);
  expect(timeline.deltas.map((delta) => delta.delta).join("")).toBe(
    toolCall.input
  );
  return { timeline, toolCall };
}

const progressiveChunks = [
  "Before ",
  "<tool_call>\n  <function=get_weather>\n    <parameter=location>Seo",
  "ul</parameter>\n    <parameter=unit>celsius</parameter>\n  </function>\n</tool_call>",
  " After",
];

describe("cross-protocol tool-input streaming events: qwen3coder", () => {
  const fixture = toolInputStreamFixtures.json;
  const protocol = qwen3CoderProtocol();

  function runQwenStream(chunks: readonly string[], useFixtureTools = true) {
    return runStreamingEventCase({
      protocol,
      tools: useFixtureTools ? fixture.tools : [],
      chunks,
      id: "fixture",
    });
  }

  it("Qwen3CoderToolParser streams tool input deltas and emits matching tool-call id", async () => {
    const out = await runQwenStream(progressiveChunks);
    const { timeline, toolCall } = expectReconciledCall(out, "get_weather");
    const leakedText = collectTextDeltas(out);

    expect(timeline.starts[0]?.toolName).toBe("get_weather");
    expect(toolCall.input).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(timeline.deltas.some((delta) => delta.delta.includes("<"))).toBe(
      false
    );
    expect(leakedText).toContain("Before");
    expect(leakedText).toContain("After");
    expect(leakedText).not.toContain("<tool_call");
    expect(leakedText).not.toContain("</tool_call");
  });

  it("Qwen3CoderToolParser preserves canonical order for all emitted AI SDK stream events", async () => {
    const out = await runQwenStream(progressiveChunks);
    assertCanonicalAiSdkEventOrder(out);
    assertCoreAiSdkEventCoverage(out);
  });

  it("Qwen3CoderToolParser preserves non-contiguous repeated parameters in streams", async () => {
    const out = await runQwenStream(
      [
        "<tool_call>\n  <function=alpha>\n    <parameter=a>1</parameter>\n    <parameter=b>2</parameter>\n    <parameter=a>3</parameter>\n  </function>\n</tool_call>",
      ],
      false
    );
    const { toolCall } = expectReconciledCall(out, "alpha");

    expect(JSON.parse(toolCall.input)).toEqual({ a: ["1", "3"], b: "2" });
  });

  it("Qwen3CoderToolParser streams tool calls when <tool_call> wrapper is missing", async () => {
    const out = await runQwenStream([
      "Before ",
      "<function=get_weather><parameter=location>Seoul</parameter><parameter=unit>celsius</parameter></function>",
      " After",
    ]);
    const { toolCall } = expectReconciledCall(out, "get_weather");
    const leakedText = collectTextDeltas(out);

    expect(toolCall).toBeTruthy();
    expect(toolCall.input).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(leakedText).toContain("Before");
    expect(leakedText).toContain("After");
    expect(leakedText).not.toContain("<function");
    expect(leakedText).not.toContain("</function");
  });
});
