import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import { toolInputStreamFixtures } from "../../../fixtures/tool-input-stream-fixtures";
import {
  assertCanonicalAiSdkEventOrder,
  assertCoreAiSdkEventCoverage,
  createInterleavedStream,
  extractToolInputTimeline,
  runProtocolStreamParser,
  runProtocolTextDeltaStream,
} from "./streaming-events.shared";

describe("cross-protocol tool-input streaming events: yaml xml", () => {
  const fixture = toolInputStreamFixtures.yaml;
  const protocol = yamlXmlProtocol();

  it("yaml protocol streams tool input deltas and emits matching tool-call id", async () => {
    const out = await runProtocolTextDeltaStream({
      protocol,
      tools: fixture.tools,
      chunks: fixture.progressiveChunks,
    });

    const { starts, deltas, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(deltas.length).toBeGreaterThan(0);
    expect(ends).toHaveLength(1);
    expect(starts[0].id).toBe(ends[0].id);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.input).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(deltas.map((delta) => delta.delta)).toEqual(
      fixture.expectedProgressDeltas
    );
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
  });

  it("yaml protocol preserves canonical order for all emitted AI SDK stream events", async () => {
    const out = await runProtocolTextDeltaStream({
      protocol,
      tools: fixture.tools,
      chunks: ["Before ", ...fixture.progressiveChunks, " After"],
    });

    assertCanonicalAiSdkEventOrder(out);
    assertCoreAiSdkEventCoverage(out);
  });

  it("yaml protocol emits '{}' tool-input-delta for self-closing tags", async () => {
    const out = await runProtocolTextDeltaStream({
      protocol,
      tools: fixture.tools,
      chunks: ["Before ", "<get_weather/>", " After"],
    });

    const { starts, deltas, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.input).toBe("{}");
    expect(deltas.map((delta) => delta.delta)).toEqual(["{}"]);
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
  });

  it("yaml protocol force-completes unclosed tool block at finish when content is parseable", async () => {
    const out = await runProtocolTextDeltaStream({
      protocol,
      tools: fixture.tools,
      chunks: fixture.finishReconcileChunks,
    });

    const { starts, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.input).toBe(fixture.expectedFinishInput);
  });

  it("yaml finish reconciliation ignores trailing partial close-tag and still emits tool-call", async () => {
    const out = await runProtocolTextDeltaStream({
      protocol,
      tools: fixture.tools,
      chunks: ["<get_weather>\nlocation: Seoul\nunit: celsius\n</get_wea"],
    });

    const { starts, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as
      | {
          type: "tool-call";
          toolCallId: string;
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
    expect(toolCall?.toolCallId).toBe(starts[0].id);
    expect(JSON.parse(toolCall?.input ?? "{}")).toEqual({
      location: "Seoul",
      unit: "celsius",
    });
    expect(leakedText).not.toContain("</get_wea");
  });

  it("yaml protocol does not prematurely finalize tool call when non-text chunks are interleaved", async () => {
    const out = await runProtocolStreamParser({
      protocol,
      tools: fixture.tools,
      stream: createInterleavedStream([
        {
          type: "text-delta",
          id: "fixture",
          delta: "<get_weather>\nlocation: Seo",
        },
        {
          type: "tool-call",
          toolCallId: "passthrough-yaml",
          toolName: "passthrough_marker",
          input: "{}",
        } satisfies LanguageModelV3StreamPart,
        {
          type: "text-delta",
          id: "fixture",
          delta: "ul\nunit: celsius\n</get_weather>",
        },
      ]),
    });

    const parsedCalls = out.filter(
      (part) => part.type === "tool-call" && part.toolName === "get_weather"
    ) as Array<{
      type: "tool-call";
      toolName: string;
      input: string;
    }>;
    const leakedText = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");

    expect(parsedCalls).toHaveLength(1);
    expect(parsedCalls[0].input).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(leakedText).not.toContain("<get_weather>");
    expect(leakedText).not.toContain("</get_weather>");
  });

  it("yaml malformed fixture stays non-leaking without dangling tool-input stream", async () => {
    const out = await runProtocolTextDeltaStream({
      protocol,
      tools: fixture.tools,
      chunks: fixture.malformedChunks,
    });

    const { starts, ends } = extractToolInputTimeline(out);
    const text = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");
    expect(starts.length).toBe(ends.length);
    expect(text).not.toContain("<get_weather>");
    expect(out.some((part) => part.type === "finish")).toBe(true);
  });
});
