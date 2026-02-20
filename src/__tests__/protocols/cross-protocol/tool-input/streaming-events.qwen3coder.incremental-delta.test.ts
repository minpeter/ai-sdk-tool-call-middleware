import { describe, expect, it } from "vitest";

import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { toolInputStreamFixtures } from "../../../fixtures/tool-input-stream-fixtures";
import {
  extractToolInputTimeline,
  runProtocolTextDeltaStream,
} from "./streaming-events.shared";

describe("cross-protocol tool-input streaming events: qwen3coder", () => {
  const fixture = toolInputStreamFixtures.json;
  const protocol = qwen3CoderProtocol();

  function runQwenIncrementalStream(chunks: string[], tools = fixture.tools) {
    return runProtocolTextDeltaStream({ protocol, tools, chunks });
  }

  it("Qwen3CoderToolParser emits incremental deltas as parameters arrive in separate chunks", async () => {
    const out = await runQwenIncrementalStream([
      "<tool_call>\n<function=get_weather>\n<parameter=location>Seoul</parameter>",
      "\n<parameter=unit>celsius</parameter>\n</function>\n</tool_call>",
    ]);

    const { starts, deltas, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(ends).toHaveLength(1);
    expect(starts[0].toolName).toBe("get_weather");
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.input).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
  });

  it("Qwen3CoderToolParser emits incremental deltas for implicit call (no wrapper)", async () => {
    const out = await runQwenIncrementalStream(
      [
        "<function=search>\n<parameter=query>hello</parameter>",
        "\n<parameter=limit>10</parameter>\n</function>",
      ],
      []
    );

    const { starts, deltas, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(ends).toHaveLength(1);
    expect(starts[0].toolName).toBe("search");
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.toolName).toBe("search");
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
  });

  it("Qwen3CoderToolParser handles repeated parameter (array) across chunks gracefully", async () => {
    const out = await runQwenIncrementalStream(
      [
        "<tool_call>\n<function=multi>\n<parameter=tags>a</parameter>",
        "\n<parameter=tags>b</parameter>\n</function>\n</tool_call>",
      ],
      []
    );

    const { starts, deltas, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.toolName).toBe("multi");
    expect(JSON.parse(toolCall.input)).toEqual({ tags: ["a", "b"] });
    expect(deltas.length).toBeGreaterThan(0);
    // Note: intermediate delta may be dropped due to non-monotonic JSON prefix when array grows
    // The final tool-call input is correct even if deltas don't form a complete prefix chain
  });
});
