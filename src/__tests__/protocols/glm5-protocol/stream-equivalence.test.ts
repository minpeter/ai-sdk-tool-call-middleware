import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { glm5Protocol } from "../../../core/protocols/glm5-protocol";
import type { ParserOptions } from "../../../core/protocols/protocol-interface";
import { stopFinishReason, zeroUsage } from "../../test-helpers";
import {
  extractTextDeltas,
  extractToolInputTimeline,
  runProtocolTextDeltaStream,
} from "../cross-protocol/tool-input/streaming-events.shared";
import {
  glm5Tools,
  normalizeContentToolCalls,
  normalizeStreamToolCalls,
} from "./shared";

const CANONICAL_CALL = [
  "<tool_call>typed_action",
  "<arg_key>text</arg_key><arg_value>hello 🚀</arg_value>",
  "<arg_key>count</arg_key><arg_value>7</arg_value>",
  "<arg_key>enabled</arg_key><arg_value>true</arg_value>",
  '<arg_key>tags</arg_key><arg_value>["a","b"]</arg_value>',
  "</tool_call>",
].join("");

interface StreamHarness {
  finish: () => Promise<LanguageModelV4StreamPart[]>;
  parts: LanguageModelV4StreamPart[];
  writeText: (delta: string) => Promise<void>;
}

function createStreamHarness(options?: ParserOptions): StreamHarness {
  const transformer = glm5Protocol().createStreamParser({
    tools: glm5Tools,
    options,
  });
  const writer = transformer.writable.getWriter();
  const reader = transformer.readable.getReader();
  const parts: LanguageModelV4StreamPart[] = [];
  const collect = (async () => {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return;
      }
      parts.push(result.value);
    }
  })();

  return {
    parts,
    async writeText(delta) {
      await writer.write({ type: "text-delta", id: "fixture", delta });
    },
    async finish() {
      await writer.write({
        type: "finish",
        finishReason: stopFinishReason,
        usage: zeroUsage,
      });
      await writer.close();
      await collect;
      return parts;
    },
  };
}

function assertBalancedToolInputLifecycle(
  parts: LanguageModelV4StreamPart[]
): void {
  const timeline = extractToolInputTimeline(parts);
  expect(timeline.starts.length).toBe(timeline.ends.length);
  for (const start of timeline.starts) {
    expect(timeline.ends.filter((end) => end.id === start.id)).toHaveLength(1);
  }
  for (const call of parts.filter((part) => part.type === "tool-call")) {
    expect(timeline.starts.some((start) => start.id === call.toolCallId)).toBe(
      true
    );
    expect(timeline.ends.some((end) => end.id === call.toolCallId)).toBe(true);
    expect(
      timeline.deltas
        .filter((delta) => delta.id === call.toolCallId)
        .map((delta) => delta.delta)
        .join("")
    ).toBe(call.input);
  }
}

describe("glm5Protocol streaming/non-streaming equivalence", () => {
  it("keeps a complete bare-call prefix as text when later prose arrives", async () => {
    const prefix = 'get-weather(city="Seoul")';
    const text = `${prefix} is an example.`;
    const protocol = glm5Protocol();
    const generated = protocol.parseGeneratedText({ text, tools: glm5Tools });
    const harness = createStreamHarness();

    await harness.writeText(prefix);
    expect(normalizeStreamToolCalls(harness.parts)).toEqual([]);
    await harness.writeText(" is an example.");
    const streamed = await harness.finish();

    expect(normalizeStreamToolCalls(streamed)).toEqual(
      normalizeContentToolCalls(generated)
    );
    expect(extractTextDeltas(streamed)).toBe(text);
    assertBalancedToolInputLifecycle(streamed);
  });

  it("recovers a terminal anchored bare call like the generate path", async () => {
    const text = 'get-weather(city="Seoul")';
    const protocol = glm5Protocol();
    const generated = protocol.parseGeneratedText({ text, tools: glm5Tools });
    const streamed = await runProtocolTextDeltaStream({
      protocol,
      tools: glm5Tools,
      chunks: text.split(""),
    });

    expect(normalizeStreamToolCalls(streamed)).toEqual(
      normalizeContentToolCalls(generated)
    );
    expect(extractTextDeltas(streamed)).toBe("");
    assertBalancedToolInputLifecycle(streamed);
  });

  const cases = [
    {
      name: "canonical typed call",
      text: CANONICAL_CALL,
    },
    {
      name: "zero-argument call",
      text: "<tool_call>ping</tool_call>",
    },
    {
      name: "two adjacent calls",
      text: [
        "<tool_call>get-weather<arg_key>city</arg_key><arg_value>Seoul</arg_value></tool_call>",
        "<tool_call>ping</tool_call>",
      ].join(""),
    },
    {
      name: "recoverable names and structural closes",
      text: "<tool_call>GET_WEATHER<arg_key>CITY<arg_value>Daegu",
    },
    {
      name: "unknown argument drop",
      text: [
        "<tool_call>get-weather",
        "<arg_key>city</arg_key><arg_value>Busan</arg_value>",
        "<arg_key>unknown</arg_key><arg_value>drop</arg_value>",
        "</tool_call>",
      ].join(""),
    },
  ];

  it.each(cases)("produces identical final calls: $name", async ({ text }) => {
    const protocol = glm5Protocol();
    const generated = protocol.parseGeneratedText({ text, tools: glm5Tools });
    const streamed = await runProtocolTextDeltaStream({
      protocol,
      tools: glm5Tools,
      chunks: text.split(""),
    });

    expect(normalizeStreamToolCalls(streamed)).toEqual(
      normalizeContentToolCalls(generated)
    );
    for (const call of streamed.filter((part) => part.type === "tool-call")) {
      const deltas = streamed
        .filter(
          (
            part
          ): part is Extract<
            LanguageModelV4StreamPart,
            { type: "tool-input-delta" }
          > => part.type === "tool-input-delta" && part.id === call.toolCallId
        )
        .map((part) => part.delta)
        .join("");
      expect(deltas).toBe(call.input);
    }
  });
});
