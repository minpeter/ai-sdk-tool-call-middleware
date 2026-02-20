import { describe, expect, it } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import { toolInputStreamFixtures } from "../../../fixtures/tool-input-stream-fixtures";
import {
  assertCanonicalAiSdkEventOrder,
  assertCoreAiSdkEventCoverage,
  extractToolInputTimeline,
  runProtocolTextDeltaStream,
} from "./streaming-events.shared";

describe("cross-protocol tool-input streaming events: hermes json", () => {
  const fixture = toolInputStreamFixtures.json;
  const protocol = hermesProtocol();

  function runHermesJsonStream(chunks: string[]) {
    return runProtocolTextDeltaStream({
      protocol,
      tools: fixture.tools,
      chunks,
    });
  }

  it("json protocol emits tool-input-start/delta/end and reconciles id with tool-call", async () => {
    const out = await runHermesJsonStream(fixture.progressiveChunks);

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
    expect(starts[0].toolName).toBe("get_weather");
    expect(starts[0].id).toBe(ends[0].id);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.toolName).toBe("get_weather");
    expect(toolCall.input).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
  });

  it("json protocol preserves canonical order for all emitted AI SDK stream events", async () => {
    const out = await runHermesJsonStream(fixture.progressiveChunks);

    assertCanonicalAiSdkEventOrder(out);
    assertCoreAiSdkEventCoverage(out);
  });

  it("json protocol force-completes tool input at finish when closing tag is missing", async () => {
    const out = await runHermesJsonStream(fixture.finishReconcileChunks);

    const { starts, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(toolCall).toBeTruthy();
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(JSON.parse(toolCall.input)).toEqual({
      location: "Busan",
      unit: "celsius",
    });
  });

  it("json finish reconciliation does not leak partial end-tag text when recovery succeeds", async () => {
    const out = await runHermesJsonStream([
      '<tool_call>{"name":"get_weather","arguments":{"location":"Busan","unit":"celsius"}}',
      "</tool_",
    ]);

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
    expect(toolCall?.toolName).toBe("get_weather");
    expect(JSON.parse(toolCall?.input ?? "{}")).toEqual({
      location: "Busan",
      unit: "celsius",
    });
    expect(leakedText).not.toContain("<tool_call>");
    expect(leakedText).not.toContain("</tool_");
  });

  it("json protocol normalizes streamed arguments:null progress to match final tool-call input", async () => {
    const out = await runHermesJsonStream([
      '<tool_call>{"name":"get_weather","arguments":null',
      "}</tool_call>",
    ]);

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
    expect(toolCall.input).toBe("{}");
    expect(deltas.map((delta) => delta.delta)).toEqual(["{}"]);
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
  });

  it("json protocol does not emit non-canonical partial literal prefixes for split null arguments", async () => {
    const out = await runHermesJsonStream([
      '<tool_call>{"name":"get_weather","arguments":n',
      "ull}</tool_call>",
    ]);

    const { starts, deltas, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(toolCall.input).toBe("{}");
    expect(deltas.map((delta) => delta.delta)).toEqual(["{}"]);
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
  });

  it("json protocol canonicalizes pretty-printed arguments progress before emitting deltas", async () => {
    const out = await runHermesJsonStream([
      '<tool_call>{"name":"get_weather","arguments":{\n  "location": "Seoul",',
      '\n  "unit": "celsius"\n}}</tool_call>',
    ]);

    const { starts, deltas, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(toolCall.input).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(deltas.map((delta) => delta.delta)).toEqual([
      '{"location":"Seoul","unit":"celsius"}',
    ]);
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
  });

  it("json protocol emits tool-input deltas for parseable arguments even when outer JSON is incomplete", async () => {
    const out = await runHermesJsonStream([
      '<tool_call>{"meta":{"msg":"{"},"name":"get_weather","arguments":{"location":"Seoul","unit":"celsius"}',
    ]);

    const { starts, deltas, ends } = extractToolInputTimeline(out);
    const leakedText = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(deltas.map((delta) => delta.delta).join("")).toBe(
      '{"location":"Seoul","unit":"celsius"}'
    );
    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(leakedText).not.toContain("<tool_call>");
  });

  it("json malformed fixture does not leave dangling tool-input stream", async () => {
    const out = await runHermesJsonStream(fixture.malformedChunks);

    const { starts, ends } = extractToolInputTimeline(out);
    expect(starts.length).toBe(ends.length);
    expect(out.some((part) => part.type === "finish")).toBe(true);
  });
});
