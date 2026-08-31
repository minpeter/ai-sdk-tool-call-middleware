import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { resolveGlm5ProtocolOptions } from "../../../core/protocols/glm5-call-parsing";
import { glm5Protocol } from "../../../core/protocols/glm5-protocol";
import { createGlm5StreamParser } from "../../../core/protocols/glm5-stream-parser";
import type { ParserOptions } from "../../../core/protocols/protocol-interface";
import { stopFinishReason, zeroUsage } from "../../test-helpers";
import {
  extractTextDeltas,
  extractToolInputTimeline,
} from "../cross-protocol/tool-input/streaming-events.shared";
import {
  glm5Tools,
  normalizeContentToolCalls,
  normalizeStreamToolCalls,
} from "./shared";

const CLOSE_TAG = "</tool_call>";
const BODY_PREFIX = "echo<arg_key>message</arg_key><arg_value>";
const BODY_SUFFIX = "</arg_value>";
const BODY_LENGTH_LIMIT = 64;
const BODY_AT_LIMIT = `${BODY_PREFIX}${"x".repeat(
  BODY_LENGTH_LIMIT - BODY_PREFIX.length - BODY_SUFFIX.length
)}${BODY_SUFFIX}`;
type OnError = NonNullable<ParserOptions["onError"]>;

async function runStream(
  chunks: readonly string[],
  bodyLengthLimit: number,
  onError: OnError
): Promise<LanguageModelV4StreamPart[]> {
  const transformer = createGlm5StreamParser({
    bodyLengthLimit,
    options: { emitRawToolCallTextOnError: true, onError },
    protocolOptions: resolveGlm5ProtocolOptions(),
    tools: glm5Tools,
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

  for (const delta of chunks) {
    if (delta.length > 0) {
      await writer.write({ delta, id: "fixture", type: "text-delta" });
    }
  }
  await writer.write({
    finishReason: stopFinishReason,
    type: "finish",
    usage: zeroUsage,
  });
  await writer.close();
  await collect;
  return parts;
}

function closeTagChunks(body: string, split: number): readonly string[] {
  return [
    `<tool_call>${body}`,
    CLOSE_TAG.slice(0, split),
    CLOSE_TAG.slice(split),
  ];
}

describe("GLM-5.2 streamed body length boundary", () => {
  it("matches generate for an exact-limit body across every close-tag chunk boundary", async () => {
    // Given
    const text = `<tool_call>${BODY_AT_LIMIT}${CLOSE_TAG}`;
    const generated = glm5Protocol().parseGeneratedText({
      text,
      tools: glm5Tools,
    });

    for (let split = 0; split <= CLOSE_TAG.length; split += 1) {
      const onError = vi.fn<OnError>();

      // When
      const streamed = await runStream(
        closeTagChunks(BODY_AT_LIMIT, split),
        BODY_LENGTH_LIMIT,
        onError
      );

      // Then
      expect(normalizeStreamToolCalls(streamed), `split ${split}`).toEqual(
        normalizeContentToolCalls(generated)
      );
      expect(onError, `split ${split}`).not.toHaveBeenCalled();
    }
  });

  it("poisons a one-character-over body across every close-tag chunk boundary", async () => {
    // Given
    const bodyOverLimit = `${BODY_PREFIX}${"x".repeat(
      BODY_LENGTH_LIMIT - BODY_PREFIX.length - BODY_SUFFIX.length + 1
    )}${BODY_SUFFIX}`;

    for (let split = 0; split <= CLOSE_TAG.length; split += 1) {
      const onError = vi.fn<OnError>();

      // When
      const streamed = await runStream(
        closeTagChunks(bodyOverLimit, split),
        BODY_LENGTH_LIMIT,
        onError
      );

      // Then
      expect(normalizeStreamToolCalls(streamed), `split ${split}`).toEqual([]);
      expect(extractTextDeltas(streamed), `split ${split}`).toBe("");
      expect(onError, `split ${split}`).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]?.[1], `split ${split}`).toEqual(
        expect.objectContaining({
          bodyLengthLimit: BODY_LENGTH_LIMIT,
          toolCall: "[oversized GLM-5.2 tool call omitted]",
        })
      );
      const timeline = extractToolInputTimeline(streamed);
      expect(timeline.starts, `split ${split}`).toHaveLength(
        timeline.ends.length
      );
    }
  });
});
