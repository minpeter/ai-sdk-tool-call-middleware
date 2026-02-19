import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";

import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { toolInputStreamFixtures } from "../../../fixtures/tool-input-stream-fixtures";
import { pipeWithTransformer } from "../../../test-helpers";
import {
  createTextDeltaStream,
  extractToolInputTimeline,
} from "./streaming-events.qwen3coder.shared";

describe("cross-protocol tool-input streaming events: qwen3coder", () => {
  it("Qwen3CoderToolParser handles missing </function> inside <tool_call> during streaming", async () => {
    const fixture = toolInputStreamFixtures.json;
    const protocol = qwen3CoderProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "Before ",
          "<tool_call>\n  <function=get_weather>\n    <parameter=location>Seoul</parameter>\n    <parameter=unit>celsius</parameter>\n</tool_call>",
        ]),
        transformer
      )
    );

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
    expect(leakedText).not.toContain("<tool_call");
    expect(leakedText).not.toContain("</tool_call");
  });

  it("Qwen3CoderToolParser handles a missing </function> boundary followed by another function", async () => {
    const protocol = qwen3CoderProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "<tool_call><function=alpha><parameter=x>1</parameter><function=beta><parameter=y>2</parameter></function></tool_call>",
        ]),
        transformer
      )
    );

    const toolCalls = out.filter((part) => part.type === "tool-call") as Array<{
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: string;
    }>;
    const text = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]?.toolName).toBe("alpha");
    expect(toolCalls[1]?.toolName).toBe("beta");
    expect(JSON.parse(toolCalls[0]?.input ?? "{}")).toEqual({ x: "1" });
    expect(JSON.parse(toolCalls[1]?.input ?? "{}")).toEqual({ y: "2" });
    expect(text).not.toContain("<function=alpha");
    expect(text).not.toContain("<function=beta");
  });

  it("Qwen3CoderToolParser ignores stray </tool_call> before an implicit <function> call", async () => {
    const protocol = qwen3CoderProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "</tool_call>\n",
          "<function=alpha><parameter=x>1</parameter></function>",
        ]),
        transformer
      )
    );

    const toolCall = out.find((part) => part.type === "tool-call") as
      | {
          type: "tool-call";
          toolName: string;
          input: string;
        }
      | undefined;
    const leakedText = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");

    expect(toolCall).toBeTruthy();
    expect(toolCall?.toolName).toBe("alpha");
    expect(JSON.parse(toolCall?.input ?? "{}")).toEqual({ x: "1" });
    expect(leakedText).not.toContain("</tool_call>");
  });

  it("Qwen3CoderToolParser recovers missing </parameter> during streaming by using next-tag boundary", async () => {
    const protocol = qwen3CoderProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "<tool_call><function=alpha><parameter=a>1<parameter=b>2</parameter></function></tool_call>",
        ]),
        transformer
      )
    );

    const toolCall = out.find((part) => part.type === "tool-call") as
      | {
          type: "tool-call";
          toolName: string;
          input: string;
        }
      | undefined;

    expect(toolCall).toBeTruthy();
    expect(toolCall?.toolName).toBe("alpha");
    expect(JSON.parse(toolCall?.input ?? "{}")).toEqual({ a: "1", b: "2" });
  });

  it("Qwen3CoderToolParser recovers final missing </parameter> before </function> during streaming", async () => {
    const protocol = qwen3CoderProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "<tool_call><function=alpha><parameter=x>1</function></tool_call>",
        ]),
        transformer
      )
    );

    const toolCall = out.find((part) => part.type === "tool-call") as
      | {
          type: "tool-call";
          toolName: string;
          input: string;
        }
      | undefined;

    expect(toolCall).toBeTruthy();
    expect(toolCall?.toolName).toBe("alpha");
    expect(JSON.parse(toolCall?.input ?? "{}")).toEqual({ x: "1" });
  });

  it("Qwen3CoderToolParser recovers final missing </parameter> before </call>/</tool>/</invoke> during streaming", async () => {
    const protocol = qwen3CoderProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "<tool_call><call=alpha><parameter=x>1</call><tool=beta><parameter=y>2</tool><invoke=gamma><parameter=z>3</invoke></tool_call>",
        ]),
        transformer
      )
    );

    const toolCalls = out.filter((part) => part.type === "tool-call") as Array<{
      type: "tool-call";
      toolName: string;
      input: string;
    }>;

    expect(toolCalls).toHaveLength(3);
    expect(toolCalls[0]?.toolName).toBe("alpha");
    expect(JSON.parse(toolCalls[0]?.input ?? "{}")).toEqual({ x: "1" });
    expect(toolCalls[1]?.toolName).toBe("beta");
    expect(JSON.parse(toolCalls[1]?.input ?? "{}")).toEqual({ y: "2" });
    expect(toolCalls[2]?.toolName).toBe("gamma");
    expect(JSON.parse(toolCalls[2]?.input ?? "{}")).toEqual({ z: "3" });
  });

  it("Qwen3CoderToolParser supports multiple function calls inside a single <tool_call> block in-order", async () => {
    const protocol = qwen3CoderProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "prefix ",
          "<tool_call>\n  <function=alpha>\n    <parameter=x>1</parameter>\n  </function>\n  <function=beta>\n    <parameter=y> 2 </parameter>\n    <parameter=y>3</parameter>\n  </function>\n</tool_call>",
          " suffix",
        ]),
        transformer
      )
    );

    const toolCalls = out.filter((part) => part.type === "tool-call") as Array<{
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: string;
    }>;

    const { starts, deltas, ends } = extractToolInputTimeline(out);

    expect(toolCalls.map((c) => c.toolName)).toEqual(["alpha", "beta"]);
    expect(JSON.parse(toolCalls[0].input)).toEqual({ x: "1" });
    expect(JSON.parse(toolCalls[1].input)).toEqual({ y: ["2", "3"] });

    for (const toolCall of toolCalls) {
      const start = starts.find((s) => s.id === toolCall.toolCallId);
      const end = ends.find((e) => e.id === toolCall.toolCallId);
      const joined = deltas
        .filter((d) => d.id === toolCall.toolCallId)
        .map((d) => d.delta)
        .join("");

      expect(start).toBeTruthy();
      expect(end).toBeTruthy();
      expect(joined).toBe(toolCall.input);
    }
  });

  it("Qwen3CoderToolParser ends active call when next <function> starts without </function>", async () => {
    const protocol = qwen3CoderProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "<tool_call><function=alpha><parameter=x>1</parameter><function=beta><parameter=y>2</parameter></tool_call>",
        ]),
        transformer
      )
    );

    const toolCalls = out.filter((part) => part.type === "tool-call") as Array<{
      type: "tool-call";
      toolName: string;
      input: string;
    }>;

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]?.toolName).toBe("alpha");
    expect(JSON.parse(toolCalls[0]?.input ?? "{}")).toEqual({ x: "1" });
    expect(toolCalls[1]?.toolName).toBe("beta");
    expect(JSON.parse(toolCalls[1]?.input ?? "{}")).toEqual({ y: "2" });
  });

  it("Qwen3CoderToolParser force-completes unclosed tool block at finish when content is parseable", async () => {
    const fixture = toolInputStreamFixtures.json;
    const protocol = qwen3CoderProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "<tool_call>\n  <function=get_weather>\n    <parameter=location>Busan</parameter>\n    <parameter=unit>celsius</parameter>\n",
        ]),
        transformer
      )
    );

    const { starts, ends } = extractToolInputTimeline(out);
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
    expect(ends).toHaveLength(1);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.toolName).toBe("get_weather");
    expect(JSON.parse(toolCall.input)).toEqual({
      location: "Busan",
      unit: "celsius",
    });
    expect(leakedText).not.toContain("<tool_call");
  });

  it("Qwen3CoderToolParser preserves trailing text when implicit call is force-completed at finish", async () => {
    const fixture = toolInputStreamFixtures.json;
    const protocol = qwen3CoderProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "before <function=get_weather><parameter=location>Busan</parameter> after",
        ]),
        transformer
      )
    );

    const { starts, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: string;
    };
    const textOut = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.toolName).toBe("get_weather");
    expect(JSON.parse(toolCall.input)).toEqual({ location: "Busan" });
    expect(textOut).toContain("before ");
    expect(textOut).toContain(" after");
    expect(textOut).not.toContain("<function=get_weather>");
  });
});
