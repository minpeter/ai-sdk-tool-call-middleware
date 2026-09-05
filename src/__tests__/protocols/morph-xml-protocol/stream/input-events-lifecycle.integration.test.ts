import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import {
  collectTextDeltas,
  parseToolCallObject,
  runProtocolTextStream,
  selectToolCalls,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "get_weather",
    description: "",
    inputSchema: {
      type: "object",
      properties: { location: { type: "string" } },
      required: ["location"],
      additionalProperties: false,
    },
  },
];

function streamedLifecycle(
  chunks: readonly string[],
  streamTools: LanguageModelV4FunctionTool[]
) {
  return runProtocolTextStream({
    chunks,
    id: "legacy-fixture",
    protocol: morphXmlProtocol(),
    tools: streamTools,
  });
}

function expectSingleLifecycle(
  parts: readonly LanguageModelV4StreamPart[],
  toolName: string
) {
  const timeline = selectToolInputTimeline(parts);
  const calls = selectToolCalls(parts);

  expect(timeline.starts).toHaveLength(1);
  expect(timeline.ends).toHaveLength(1);
  expect(calls).toHaveLength(1);
  expect(timeline.starts[0]?.toolName).toBe(toolName);
  return { calls, ends: timeline.ends, starts: timeline.starts };
}

describe("morphXmlProtocol stream tool-input lifecycle integration", () => {
  it("keeps tool-input lifecycle order as start -> end -> tool-call for XML", async () => {
    const out = await streamedLifecycle(
      [
        "prefix ",
        "<get_weather>",
        "<location>NY</location>",
        "</get_weather>",
        " suffix",
      ],
      tools
    );
    const { starts, ends, calls } = expectSingleLifecycle(out, "get_weather");
    expect(starts[0]?.id).toBe(ends[0]?.id);
    expect(starts[0]?.id).toBe(calls[0]?.toolCallId);
    expect(calls[0]?.input).toBe('{"location":"NY"}');

    const startIndex = out.findIndex(
      (part) => part.type === "tool-input-start"
    );
    const endIndex = out.findIndex((part) => part.type === "tool-input-end");
    const callIndex = out.findIndex((part) => part.type === "tool-call");
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(startIndex);
    expect(callIndex).toBeGreaterThan(endIndex);
  });

  it("matches closing tag literally when tool name contains regex metacharacters", async () => {
    const out = await streamedLifecycle(
      [
        "prefix ",
        "<weather.v2>",
        "<location>Seoul</location>",
        "<weatherXv2>noise</weatherXv2>",
        "</weather.v2>",
        " suffix",
      ],
      [
        {
          type: "function",
          name: "weather.v2",
          description: "",
          inputSchema: {
            type: "object",
            properties: { location: { type: "string" } },
            required: ["location"],
          },
        },
      ]
    );
    const { calls } = expectSingleLifecycle(out, "weather.v2");
    expect(calls[0]?.toolName).toBe("weather.v2");
    const [call] = calls;
    expect(
      call === undefined ? undefined : parseToolCallObject(call).location
    ).toBe("Seoul");

    const textOutput = collectTextDeltas(out);
    expect(textOutput).toContain("prefix ");
    expect(textOutput).toContain(" suffix");
    expect(textOutput).not.toContain("</weather.v2>");
  });
});
