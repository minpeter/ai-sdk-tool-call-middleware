import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGlm5ProtocolOptions } from "../../../core/protocols/glm5-call-parsing";
import { glm5Protocol } from "../../../core/protocols/glm5-protocol";
import { createGlm5StreamParser } from "../../../core/protocols/glm5-stream-parser";
import { stopFinishReason, zeroUsage } from "../../test-helpers";
import {
  assertCanonicalAiSdkEventOrder,
  extractTextDeltas,
  extractToolInputDeltas,
  extractToolInputTimeline,
  findToolCall,
  runProtocolTextDeltaStream,
} from "../cross-protocol/tool-input/streaming-events.shared";
import { glm5Tools, normalizeStreamToolCalls } from "./shared";

const bodyWork = vi.hoisted(() => ({ materializedCharacters: 0 }));

vi.mock("../../../core/protocols/glm5-stream-body", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../core/protocols/glm5-stream-body")
    >();
  return {
    ...actual,
    createGlm5StreamBody: (initial = "") =>
      actual.createGlm5StreamBody(initial, (characters) => {
        bodyWork.materializedCharacters += characters;
      }),
  };
});

async function runParser(
  parser: TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>,
  chunks: readonly string[]
): Promise<LanguageModelV4StreamPart[]> {
  const writer = parser.writable.getWriter();
  const reader = parser.readable.getReader();
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
  for (const delta of chunks) {
    await writer.write({ type: "text-delta", id: "fixture", delta });
  }
  await writer.write({
    type: "finish",
    finishReason: stopFinishReason,
    usage: zeroUsage,
  });
  await writer.close();
  await collect;
  return parts;
}

beforeEach(() => {
  bodyWork.materializedCharacters = 0;
});

describe("GLM-5 stream work bounds", () => {
  it.each(["plain </tail", "plain <tool_X tail"])(
    "preserves a non-structural tag prefix as text: %s",
    async (text) => {
      const output = await runProtocolTextDeltaStream({
        protocol: glm5Protocol(),
        tools: glm5Tools,
        chunks: text.split(""),
      });

      expect(extractTextDeltas(output)).toBe(text);
      expect(normalizeStreamToolCalls(output)).toEqual([]);
    }
  );

  it("bounds retained-body materialization across one-character chunks", async () => {
    const longValue = "x".repeat(20_000);
    const text = `<tool_call>echo<arg_key>message</arg_key><arg_value>${longValue}</arg_value></tool_call>`;

    const output = await runProtocolTextDeltaStream({
      protocol: glm5Protocol(),
      tools: glm5Tools,
      chunks: text.split(""),
    });

    const call = findToolCall(output);
    const deltas = extractToolInputDeltas(output);
    const retainedBodyLength = text.length - "<tool_call>".length;
    const naiveConcatenationVolume =
      (retainedBodyLength * (retainedBodyLength + 1)) / 2;
    expect(JSON.parse(call.input)).toEqual({ message: longValue });
    expect(deltas.join("")).toBe(call.input);
    expect(extractTextDeltas(output)).toBe("");
    expect(bodyWork.materializedCharacters).toBeGreaterThanOrEqual(
      retainedBodyLength
    );
    expect(bodyWork.materializedCharacters).toBeLessThanOrEqual(
      retainedBodyLength * 8
    );
    expect(bodyWork.materializedCharacters * 100).toBeLessThan(
      naiveConcatenationVolume
    );
    assertCanonicalAiSdkEventOrder(output);
  });

  it("bounds an overflow transition and discards every later call", async () => {
    const bodyLengthLimit = 4096;
    const onError = vi.fn();
    const bodyPrefix = "echo<arg_key>message</arg_key><arg_value>";
    const bodyAtLimit = `${bodyPrefix}${"x".repeat(
      bodyLengthLimit - bodyPrefix.length
    )}`;
    const streamed = await runParser(
      createGlm5StreamParser({
        bodyLengthLimit,
        options: { emitRawToolCallTextOnError: true, onError },
        protocolOptions: resolveGlm5ProtocolOptions(),
        tools: glm5Tools,
      }),
      [
        `<tool_call>${bodyAtLimit}`,
        "x",
        "</arg_value></tool_call><tool_call>ping</tool_call>",
      ]
    );

    expect(normalizeStreamToolCalls(streamed)).toEqual([]);
    expect(extractTextDeltas(streamed)).toBe("");
    expect(streamed.at(-1)?.type).toBe("finish");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        bodyLengthLimit,
        toolCall: "[oversized GLM-5.2 tool call omitted]",
      })
    );
    const lifecycle = extractToolInputTimeline(streamed);
    expect(lifecycle.starts).toHaveLength(lifecycle.ends.length);
  });

  it("preserves safe malformed call text when raw fallback is enabled", async () => {
    const onError = vi.fn();
    const text = "<tool_call>unknown</tool_call>";
    const streamed = await runParser(
      createGlm5StreamParser({
        options: { emitRawToolCallTextOnError: true, onError },
        protocolOptions: resolveGlm5ProtocolOptions(),
        tools: glm5Tools,
      }),
      [text]
    );

    expect(extractTextDeltas(streamed)).toBe(text);
    expect(normalizeStreamToolCalls(streamed)).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
