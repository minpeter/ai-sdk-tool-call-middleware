import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import { toolInputStreamFixtures } from "../../../fixtures/tool-input-stream-fixtures";
import {
  collectTextDeltas,
  parseToolCallObject,
  requireToolCall,
  runProtocolTextStream,
  selectToolCalls,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";
import {
  assertCanonicalAiSdkEventOrder,
  assertCoreAiSdkEventCoverage,
  createInterleavedStream,
  runProtocolStreamParser,
} from "./streaming-events.shared";

describe("cross-protocol tool-input streaming events: yaml xml", () => {
  const fixture = toolInputStreamFixtures.yaml;
  const protocol = yamlXmlProtocol();

  function runYamlTextStream(chunks: readonly string[]) {
    return runProtocolTextStream({
      chunks,
      id: "fixture",
      protocol,
      tools: fixture.tools,
    });
  }

  it("yaml protocol streams tool input deltas and emits matching tool-call id", async () => {
    const out = await runYamlTextStream(fixture.progressiveChunks);

    const { starts, deltas, ends } = selectToolInputTimeline(out);
    const toolCall = requireToolCall(out);

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
    const out = await runYamlTextStream([
      "Before ",
      ...fixture.progressiveChunks,
      " After",
    ]);

    assertCanonicalAiSdkEventOrder(out);
    assertCoreAiSdkEventCoverage(out);
  });

  it("yaml protocol emits '{}' tool-input-delta for self-closing tags", async () => {
    const out = await runYamlTextStream([
      "Before ",
      "<get_weather/>",
      " After",
    ]);

    const { starts, deltas, ends } = selectToolInputTimeline(out);
    const toolCall = requireToolCall(out);

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.input).toBe("{}");
    expect(deltas.map((delta) => delta.delta)).toEqual(["{}"]);
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
  });

  it("yaml protocol force-completes unclosed tool block at finish when content is parseable", async () => {
    const out = await runYamlTextStream(fixture.finishReconcileChunks);

    const { starts, ends } = selectToolInputTimeline(out);
    const toolCall = requireToolCall(out);

    expect(toolCall.input).toBe(fixture.expectedFinishInput);
    expect(starts).toHaveLength(1);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(ends).toHaveLength(1);
  });

  it("yaml finish reconciliation ignores trailing partial close-tag and still emits tool-call", async () => {
    const out = await runYamlTextStream([
      "<get_weather>\nlocation: Seoul\nunit: celsius\n</get_wea",
    ]);

    const { starts, ends } = selectToolInputTimeline(out);
    const toolCall = requireToolCall(out);
    const leakedText = collectTextDeltas(out);

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(toolCall).toBeTruthy();
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(parseToolCallObject(toolCall)).toEqual({
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
        } satisfies LanguageModelV4StreamPart,
        {
          type: "text-delta",
          id: "fixture",
          delta: "ul\nunit: celsius\n</get_weather>",
        },
      ]),
    });

    const parsedCalls = selectToolCalls(out).filter(
      (part) => part.toolName === "get_weather"
    );
    const leakedText = collectTextDeltas(out);

    expect(parsedCalls).toHaveLength(1);
    expect(parsedCalls[0].input).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(leakedText).not.toContain("<get_weather>");
    expect(leakedText).not.toContain("</get_weather>");
  });

  it("yaml malformed fixture stays non-leaking without dangling tool-input stream", async () => {
    const out = await runYamlTextStream(fixture.malformedChunks);

    const { starts, ends } = selectToolInputTimeline(out);
    const text = collectTextDeltas(out);
    expect(starts.length).toBe(ends.length);
    expect(text).not.toContain("<get_weather>");
    expect(out.some((part) => part.type === "finish")).toBe(true);
  });
});
