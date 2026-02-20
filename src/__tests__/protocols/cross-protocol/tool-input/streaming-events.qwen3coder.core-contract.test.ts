import { describe, expect, it } from "vitest";

import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { toolInputStreamFixtures } from "../../../fixtures/tool-input-stream-fixtures";
import {
  assertCanonicalAiSdkEventOrder,
  assertCoreAiSdkEventCoverage,
  extractToolInputTimeline,
  runProtocolTextDeltaStream,
} from "./streaming-events.shared";

describe("cross-protocol tool-input streaming events: qwen3coder", () => {
  const fixture = toolInputStreamFixtures.json;
  const protocol = qwen3CoderProtocol();

  it("Qwen3CoderToolParser streams tool input deltas and emits matching tool-call id", async () => {
    const out = await runProtocolTextDeltaStream({
      protocol,
      tools: fixture.tools,
      chunks: [
        "Before ",
        "<tool_call>\n  <function=get_weather>\n    <parameter=location>Seo",
        "ul</parameter>\n    <parameter=unit>celsius</parameter>\n  </function>\n</tool_call>",
        " After",
      ],
    });

    const { starts, deltas, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: string;
    };
    const leakedText = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");

    expect(starts).toHaveLength(1);
    expect(deltas.length).toBeGreaterThan(0);
    expect(ends).toHaveLength(1);
    expect(starts[0].toolName).toBe("get_weather");
    expect(starts[0].id).toBe(ends[0].id);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.toolName).toBe("get_weather");
    expect(toolCall.input).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
    expect(deltas.some((delta) => delta.delta.includes("<"))).toBe(false);
    expect(leakedText).toContain("Before");
    expect(leakedText).toContain("After");
    expect(leakedText).not.toContain("<tool_call");
    expect(leakedText).not.toContain("</tool_call");
  });

  it("Qwen3CoderToolParser preserves canonical order for all emitted AI SDK stream events", async () => {
    const out = await runProtocolTextDeltaStream({
      protocol,
      tools: fixture.tools,
      chunks: [
        "Before ",
        "<tool_call>\n  <function=get_weather>\n    <parameter=location>Seo",
        "ul</parameter>\n    <parameter=unit>celsius</parameter>\n  </function>\n</tool_call>",
        " After",
      ],
    });

    assertCanonicalAiSdkEventOrder(out);
    assertCoreAiSdkEventCoverage(out);
  });

  it("Qwen3CoderToolParser preserves non-contiguous repeated parameters in streams", async () => {
    const out = await runProtocolTextDeltaStream({
      protocol,
      tools: [],
      chunks: [
        "<tool_call>\n  <function=alpha>\n    <parameter=a>1</parameter>\n    <parameter=b>2</parameter>\n    <parameter=a>3</parameter>\n  </function>\n</tool_call>",
      ],
    });

    const { starts, deltas, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(deltas.length).toBeGreaterThan(0);
    expect(ends).toHaveLength(1);
    expect(starts[0].id).toBe(ends[0].id);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.toolName).toBe("alpha");
    expect(JSON.parse(toolCall.input)).toEqual({ a: ["1", "3"], b: "2" });
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
  });

  it("Qwen3CoderToolParser streams tool calls when <tool_call> wrapper is missing", async () => {
    const out = await runProtocolTextDeltaStream({
      protocol,
      tools: fixture.tools,
      chunks: [
        "Before ",
        "<function=get_weather><parameter=location>Seoul</parameter><parameter=unit>celsius</parameter></function>",
        " After",
      ],
    });

    const { starts, deltas, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as
      | {
          type: "tool-call";
          toolCallId: string;
          toolName: string;
          input: string;
        }
      | undefined;

    const leakedText = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(toolCall).toBeTruthy();
    expect(starts[0].id).toBe(ends[0].id);
    expect(toolCall?.toolCallId).toBe(starts[0].id);
    expect(toolCall?.toolName).toBe("get_weather");
    expect(toolCall?.input).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall?.input);
    expect(leakedText).toContain("Before");
    expect(leakedText).toContain("After");
    expect(leakedText).not.toContain("<function");
    expect(leakedText).not.toContain("</function");
  });
});
