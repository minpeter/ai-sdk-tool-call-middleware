import { describe, expect, it } from "vitest";

import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { toolInputStreamFixtures } from "../../../fixtures/tool-input-stream-fixtures";
import {
  observeObjectDeltas,
  parseToolCallObject,
} from "../../shared/duplicate-harness";

describe("cross-protocol tool-input streaming events: qwen3coder", () => {
  const fixture = toolInputStreamFixtures.json;
  const protocol = qwen3CoderProtocol();

  function runQwenIncrementalStream(chunks: string[], tools = fixture.tools) {
    return observeObjectDeltas({
      chunks,
      id: "fixture",
      protocol,
      tools,
    });
  }

  it("Qwen3CoderToolParser emits incremental deltas as parameters arrive in separate chunks", async () => {
    const observation = await runQwenIncrementalStream([
      "<tool_call>\n<function=get_weather>\n<parameter=location>Seoul</parameter>",
      "\n<parameter=unit>celsius</parameter>\n</function>\n</tool_call>",
    ]);

    const { starts, deltas, ends } = observation.timeline;
    const { toolCall } = observation;

    expect(starts).toHaveLength(1);
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(ends).toHaveLength(1);
    expect(starts[0].toolName).toBe("get_weather");
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.input).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
  });

  it("Qwen3CoderToolParser emits incremental deltas for implicit call (no wrapper)", async () => {
    const observation = await runQwenIncrementalStream(
      [
        "<function=search>\n<parameter=query>hello</parameter>",
        "\n<parameter=limit>10</parameter>\n</function>",
      ],
      []
    );

    const { starts, deltas, ends } = observation.timeline;
    const { toolCall } = observation;

    expect(toolCall.toolName).toBe("search");
    expect(starts[0].toolName).toBe("search");
    expect(starts).toHaveLength(1);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(observation.joinedInput).toBe(toolCall.input);
    expect(ends).toHaveLength(1);
  });

  it("Qwen3CoderToolParser handles repeated parameter (array) across chunks gracefully", async () => {
    const observation = await runQwenIncrementalStream(
      [
        "<tool_call>\n<function=multi>\n<parameter=tags>a</parameter>",
        "\n<parameter=tags>b</parameter>\n</function>\n</tool_call>",
      ],
      []
    );

    const { starts, deltas, ends } = observation.timeline;
    const { toolCall } = observation;

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.toolName).toBe("multi");
    expect(parseToolCallObject(toolCall)).toEqual({ tags: ["a", "b"] });
    expect(deltas.length).toBeGreaterThan(0);
    // Intermediate delta may be dropped when array growth is not a JSON prefix.
  });
});
