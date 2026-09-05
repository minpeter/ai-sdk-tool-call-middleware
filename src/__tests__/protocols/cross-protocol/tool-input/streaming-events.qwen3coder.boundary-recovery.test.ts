import type {
  JSONObject,
  JSONValue,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { toolInputStreamFixtures } from "../../../fixtures/tool-input-stream-fixtures";
import {
  collectTextDeltas,
  runStreamingEventCase,
  selectToolCalls,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";

type ToolCall = Extract<LanguageModelV4StreamPart, { type: "tool-call" }>;

function expectNamedInputs(
  toolCalls: readonly ToolCall[],
  expected: readonly { readonly input: JSONObject; readonly name: string }[]
): void {
  expect(toolCalls).toHaveLength(expected.length);
  for (const [index, value] of expected.entries()) {
    expect(toolCalls[index]?.toolName).toBe(value.name);
    expect(JSON.parse(toolCalls[index]?.input ?? "{}")).toEqual(value.input);
  }
}

describe("cross-protocol tool-input streaming events: qwen3coder", () => {
  const fixture = toolInputStreamFixtures.json;
  const protocol = qwen3CoderProtocol();

  function runQwenStream(
    chunks: readonly string[],
    tools: LanguageModelV4FunctionTool[] = fixture.tools
  ) {
    return runStreamingEventCase({ protocol, tools, chunks, id: "fixture" });
  }

  it("Qwen3CoderToolParser handles missing </function> inside <tool_call> during streaming", async () => {
    const out = await runQwenStream([
      "Before ",
      "<tool_call>\n  <function=get_weather>\n    <parameter=location>Seoul</parameter>\n    <parameter=unit>celsius</parameter>\n</tool_call>",
    ]);
    const timeline = selectToolInputTimeline(out);
    const [toolCall] = selectToolCalls(out);
    const leakedText = collectTextDeltas(out);

    expect(toolCall).toBeTruthy();
    expect(timeline.starts).toHaveLength(1);
    expect(timeline.ends).toHaveLength(1);
    expect(timeline.starts[0]?.id).toBe(timeline.ends[0]?.id);
    expect(toolCall?.toolCallId).toBe(timeline.starts[0]?.id);
    expect(toolCall?.toolName).toBe("get_weather");
    expect(toolCall?.input).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(timeline.deltas.map((delta) => delta.delta).join("")).toBe(
      toolCall?.input
    );
    expect(leakedText).toContain("Before");
    expect(leakedText).not.toContain("<tool_call");
    expect(leakedText).not.toContain("</tool_call");
  });

  it("Qwen3CoderToolParser handles a missing </function> boundary followed by another function", async () => {
    const out = await runQwenStream(
      [
        "<tool_call><function=alpha><parameter=x>1</parameter><function=beta><parameter=y>2</parameter></function></tool_call>",
      ],
      []
    );
    const toolCalls = selectToolCalls(out);
    const text = collectTextDeltas(out);

    expectNamedInputs(toolCalls, [
      { name: "alpha", input: { x: "1" } },
      { name: "beta", input: { y: "2" } },
    ]);
    expect(text).not.toContain("<function=alpha");
    expect(text).not.toContain("<function=beta");
  });

  it("Qwen3CoderToolParser ignores stray </tool_call> before an implicit <function> call", async () => {
    const out = await runQwenStream(
      [
        "</tool_call>\n",
        "<function=alpha><parameter=x>1</parameter></function>",
      ],
      []
    );
    const [toolCall] = selectToolCalls(out);
    const leakedText = collectTextDeltas(out);

    expect(toolCall).toBeTruthy();
    expect(toolCall?.toolName).toBe("alpha");
    expect(JSON.parse(toolCall?.input ?? "{}")).toEqual({ x: "1" });
    expect(leakedText).not.toContain("</tool_call>");
  });

  const missingParameterCases = [
    {
      name: "Qwen3CoderToolParser recovers missing </parameter> during streaming by using next-tag boundary",
      input:
        "<tool_call><function=alpha><parameter=a>1<parameter=b>2</parameter></function></tool_call>",
      expected: { a: "1", b: "2" },
    },
    {
      name: "Qwen3CoderToolParser recovers final missing </parameter> before </function> during streaming",
      input: "<tool_call><function=alpha><parameter=x>1</function></tool_call>",
      expected: { x: "1" },
    },
  ];

  for (const testCase of missingParameterCases) {
    it(testCase.name, async () => {
      const out = await runQwenStream([testCase.input], []);
      const [toolCall] = selectToolCalls(out);
      const parsed: JSONValue = JSON.parse(toolCall?.input ?? "{}");
      expect(toolCall).toBeTruthy();
      expect(toolCall?.toolName).toBe("alpha");
      expect(parsed).toEqual(testCase.expected);
    });
  }

  it("Qwen3CoderToolParser recovers final missing </parameter> before </call>/</tool>/</invoke> during streaming", async () => {
    const out = await runQwenStream(
      [
        "<tool_call><call=alpha><parameter=x>1</call><tool=beta><parameter=y>2</tool><invoke=gamma><parameter=z>3</invoke></tool_call>",
      ],
      []
    );
    const toolCalls = selectToolCalls(out);

    expectNamedInputs(toolCalls, [
      { name: "alpha", input: { x: "1" } },
      { name: "beta", input: { y: "2" } },
      { name: "gamma", input: { z: "3" } },
    ]);
  });

  it("Qwen3CoderToolParser supports multiple function calls inside a single <tool_call> block in-order", async () => {
    const out = await runQwenStream(
      [
        "prefix ",
        "<tool_call>\n  <function=alpha>\n    <parameter=x>1</parameter>\n  </function>\n  <function=beta>\n    <parameter=y> 2 </parameter>\n    <parameter=y>3</parameter>\n  </function>\n</tool_call>",
        " suffix",
      ],
      []
    );
    const toolCalls = selectToolCalls(out);
    const { starts, deltas, ends } = selectToolInputTimeline(out);

    expect(toolCalls.map((call) => call.toolName)).toEqual(["alpha", "beta"]);
    expect(JSON.parse(toolCalls[0]?.input ?? "{}")).toEqual({ x: "1" });
    expect(JSON.parse(toolCalls[1]?.input ?? "{}")).toEqual({ y: ["2", "3"] });
    for (const toolCall of toolCalls) {
      const start = starts.find((part) => part.id === toolCall.toolCallId);
      const end = ends.find((part) => part.id === toolCall.toolCallId);
      const joined = deltas
        .filter((part) => part.id === toolCall.toolCallId)
        .map((part) => part.delta)
        .join("");
      expect(start).toBeTruthy();
      expect(end).toBeTruthy();
      expect(joined).toBe(toolCall.input);
    }
  });

  it("Qwen3CoderToolParser ends active call when next <function> starts without </function>", async () => {
    const out = await runQwenStream(
      [
        "<tool_call><function=alpha><parameter=x>1</parameter><function=beta><parameter=y>2</parameter></tool_call>",
      ],
      []
    );
    const toolCalls = selectToolCalls(out);

    expectNamedInputs(toolCalls, [
      { name: "alpha", input: { x: "1" } },
      { name: "beta", input: { y: "2" } },
    ]);
  });

  it("Qwen3CoderToolParser force-completes unclosed tool block at finish when content is parseable", async () => {
    const out = await runQwenStream([
      "<tool_call>\n  <function=get_weather>\n    <parameter=location>Busan</parameter>\n    <parameter=unit>celsius</parameter>\n",
    ]);
    const timeline = selectToolInputTimeline(out);
    const [toolCall] = selectToolCalls(out);
    const leakedText = collectTextDeltas(out);

    expect(toolCall?.toolCallId).toBe(timeline.starts[0]?.id);
    expect(timeline.starts).toHaveLength(1);
    expect(timeline.ends).toHaveLength(1);
    expect(toolCall?.toolName).toBe("get_weather");
    expect(JSON.parse(toolCall?.input ?? "{}")).toEqual({
      location: "Busan",
      unit: "celsius",
    });
    expect(leakedText).not.toContain("<tool_call");
  });

  it("Qwen3CoderToolParser preserves trailing text when implicit call is force-completed at finish", async () => {
    const out = await runQwenStream([
      "before <function=get_weather><parameter=location>Busan</parameter> after",
    ]);
    const timeline = selectToolInputTimeline(out);
    const [toolCall] = selectToolCalls(out);
    const textOut = collectTextDeltas(out);

    expect(timeline.starts).toHaveLength(1);
    expect(toolCall?.toolCallId).toBe(timeline.starts[0]?.id);
    expect(timeline.ends).toHaveLength(1);
    expect(toolCall?.toolName).toBe("get_weather");
    expect(JSON.parse(toolCall?.input ?? "{}")).toEqual({ location: "Busan" });
    expect(textOut).toContain("before ");
    expect(textOut).toContain(" after");
    expect(textOut).not.toContain("<function=get_weather>");
  });
});
