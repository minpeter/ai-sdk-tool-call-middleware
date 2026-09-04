import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { glm5Protocol } from "../../../core/protocols/glm5-protocol";
import { stopFinishReason, zeroUsage } from "../../test-helpers";
import {
  collectTextDeltas,
  runProtocolTextStream,
  selectToolInputTimeline,
} from "../shared/duplicate-harness";
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

function streamByCharacter(text: string): Promise<LanguageModelV4StreamPart[]> {
  return runProtocolTextStream({
    protocol: glm5Protocol(),
    tools: glm5Tools,
    chunks: text.split(""),
    id: "fixture",
  });
}

function assertBalancedToolInputLifecycle(
  parts: LanguageModelV4StreamPart[]
): void {
  const { starts, deltas, ends } = selectToolInputTimeline(parts);
  expect(starts.length).toBe(ends.length);
  for (const start of starts) {
    expect(ends.filter(({ id }) => id === start.id)).toHaveLength(1);
  }
  for (const call of parts.filter((part) => part.type === "tool-call")) {
    expect(starts.some(({ id }) => id === call.toolCallId)).toBe(true);
    expect(ends.some(({ id }) => id === call.toolCallId)).toBe(true);
    expect(
      deltas
        .filter(({ id }) => id === call.toolCallId)
        .map(({ delta }) => delta)
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
    const transformer = protocol.createStreamParser({ tools: glm5Tools });
    const writer = transformer.writable.getWriter();
    const streamed: LanguageModelV4StreamPart[] = [];
    const collected = transformer.readable.pipeTo(
      new WritableStream({
        write(part) {
          streamed.push(part);
        },
      })
    );

    await writer.write({ type: "text-delta", id: "fixture", delta: prefix });
    expect(normalizeStreamToolCalls(streamed)).toEqual([]);
    await writer.write({
      type: "text-delta",
      id: "fixture",
      delta: " is an example.",
    });
    await writer.write({
      type: "finish",
      finishReason: stopFinishReason,
      usage: zeroUsage,
    });
    await writer.close();
    await collected;

    expect(normalizeStreamToolCalls(streamed)).toEqual(
      normalizeContentToolCalls(generated)
    );
    expect(collectTextDeltas(streamed)).toBe(text);
    assertBalancedToolInputLifecycle(streamed);
  });

  it("recovers a terminal anchored bare call like the generate path", async () => {
    const text = 'get-weather(city="Seoul")';
    const generated = glm5Protocol().parseGeneratedText({
      text,
      tools: glm5Tools,
    });
    const streamed = await streamByCharacter(text);

    expect(normalizeStreamToolCalls(streamed)).toEqual(
      normalizeContentToolCalls(generated)
    );
    expect(collectTextDeltas(streamed)).toBe("");
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
    const generated = glm5Protocol().parseGeneratedText({
      text,
      tools: glm5Tools,
    });
    const streamed = await streamByCharacter(text);

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
