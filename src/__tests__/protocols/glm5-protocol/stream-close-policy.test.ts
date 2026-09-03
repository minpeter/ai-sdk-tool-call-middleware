import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { glm5Protocol } from "../../../core/protocols/glm5-protocol";
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

describe("glm5Protocol stream close policy", () => {
  it("keeps stream/non-stream parity across structural delimiter pairs", async () => {
    const tokens = [
      "plain",
      "<arg_key>",
      "</arg_key>",
      "<arg_value>",
      "</arg_value>",
      "<tool_call>",
      "</tool_call>",
      "<tool_call>x</tool_call>",
    ];
    const mismatches: Array<{
      readonly generatedSignature: {
        readonly calls: ReturnType<typeof normalizeContentToolCalls>;
        readonly text: string;
      };
      readonly message: string;
      readonly streamedSignature: {
        readonly calls: ReturnType<typeof normalizeStreamToolCalls>;
        readonly text: string;
      };
    }> = [];

    for (const left of tokens) {
      for (const right of tokens) {
        const message = `before ${left} middle ${right} after`;
        const text = `<tool_call>echo<arg_key>message</arg_key><arg_value>${message}</arg_value></tool_call>`;
        const protocol = glm5Protocol();
        const generated = protocol.parseGeneratedText({
          text,
          tools: glm5Tools,
        });
        const streamed = await runProtocolTextDeltaStream({
          protocol,
          tools: glm5Tools,
          chunks: text.split(""),
        });
        const generatedSignature = {
          calls: normalizeContentToolCalls(generated),
          text: generated
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
        };
        const streamedSignature = {
          calls: normalizeStreamToolCalls(streamed),
          text: extractTextDeltas(streamed),
        };
        if (
          JSON.stringify(streamedSignature) !==
          JSON.stringify(generatedSignature)
        ) {
          mismatches.push({ generatedSignature, message, streamedSignature });
        }
      }
    }

    expect(mismatches.slice(0, 12)).toEqual([]);
  });

  it.each([
    "before </tool_call> literal after",
    "before </arg_value> literal </tool_call> after",
    "before </arg_value></tool_call> literal after",
  ])(
    "matches non-stream close selection for raw marker mix: %s",
    async (message) => {
      const text = `<tool_call>echo<arg_key>message</arg_key><arg_value>${message}</arg_value></tool_call>`;
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
      assertBalancedToolInputLifecycle(streamed);
    }
  );

  it("enforces the bounded close-candidate policy", async () => {
    const message = "x</tool_call>".repeat(300);
    const text = `<tool_call>echo<arg_key>message</arg_key><arg_value>${message}</arg_value></tool_call>`;
    const protocol = glm5Protocol();
    const generated = protocol.parseGeneratedText({ text, tools: glm5Tools });
    const streamed = await runProtocolTextDeltaStream({
      protocol,
      tools: glm5Tools,
      chunks: text.split(""),
    });

    expect(normalizeContentToolCalls(generated)).toEqual([]);
    expect(normalizeStreamToolCalls(streamed)).toEqual([]);
    assertBalancedToolInputLifecycle(streamed);
  });

  it.each([
    ["unknown tool", "<tool_call>unknown</tool_call>"],
    [
      "duplicate argument",
      [
        "<tool_call>echo",
        "<arg_key>message</arg_key><arg_value>first</arg_value>",
        "<arg_key>message</arg_key><arg_value>second</arg_value>",
        "</tool_call>",
      ].join(""),
    ],
  ])(
    "resynchronizes after a rejected %s call under one-character chunks",
    async (_name, rejected) => {
      const text = `${rejected}<tool_call>ping</tool_call>`;
      const protocol = glm5Protocol();
      const generated = protocol.parseGeneratedText({
        text,
        tools: glm5Tools,
      });
      const streamed = await runProtocolTextDeltaStream({
        protocol,
        tools: glm5Tools,
        chunks: text.split(""),
      });

      expect(normalizeStreamToolCalls(streamed)).toEqual([
        { toolName: "ping", input: {} },
      ]);
      expect(normalizeStreamToolCalls(streamed)).toEqual(
        normalizeContentToolCalls(generated)
      );
      assertBalancedToolInputLifecycle(streamed);
    }
  );

  it("poisons a chunked stream after an oversized body", async () => {
    const onError = vi.fn();
    const text = `<tool_call>echo<arg_key>message</arg_key><arg_value>${"x".repeat(
      1_048_577
    )}</arg_value></tool_call><tool_call>ping</tool_call>`;
    const streamed = await runProtocolTextDeltaStream({
      protocol: glm5Protocol(),
      tools: glm5Tools,
      chunks: [text],
      options: { emitRawToolCallTextOnError: true, onError },
    });

    expect(normalizeStreamToolCalls(streamed)).toEqual([]);
    expect(extractTextDeltas(streamed)).toBe("");
    expect(streamed.at(-1)?.type).toBe("finish");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      "Could not parse streaming GLM-5.2 tool call.",
      expect.objectContaining({
        bodyLengthLimit: 1_048_576,
        toolCall: "[oversized GLM-5.2 tool call omitted]",
      })
    );
    assertBalancedToolInputLifecycle(streamed);
  });

  it("keeps the first recovery candidate across multiple deferred closes", async () => {
    const text = [
      "<tool_call>echo<arg_key>message</arg_key><arg_value>first",
      "</tool_call> middle </tool_call> trailing",
    ].join("");
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
    assertBalancedToolInputLifecycle(streamed);
  });
});
