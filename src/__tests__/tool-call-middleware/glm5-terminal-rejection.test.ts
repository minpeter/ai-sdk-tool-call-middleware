import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import { glm5Protocol } from "../../core/protocols/glm5-protocol";
import type { ParserOptions } from "../../core/protocols/protocol-interface";
import { originalToolsSchema } from "../../core/utils/provider-options";
import { wrapGenerate } from "../../generate-handler";
import { wrapStream } from "../../stream-handler";
import { stopFinishReason, zeroUsage } from "../test-helpers";

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "ping",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

const REJECTED_GLM_CALL =
  '<tool_call>unknown {"name":"ping","arguments":{}}</tool_call>';
const BENIGN_JSON_TEXT = '{"status":"ok"}';
const REJECTED_WITH_ADJACENT_TEXT = `${REJECTED_GLM_CALL}\n${BENIGN_JSON_TEXT}`;
const STANDALONE_JSON_CALL = '{"name":"ping","arguments":{}}';

function params(parserOptions: ParserOptions = {}) {
  return {
    providerOptions: {
      toolCallMiddleware: {
        originalTools: originalToolsSchema.encode(tools),
        ...parserOptions,
      },
    },
  };
}

function providerStream(
  text: string
): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      controller.enqueue({ type: "text-start", id: "text" });
      controller.enqueue({ type: "text-delta", id: "text", delta: text });
      controller.enqueue({ type: "text-end", id: "text" });
      controller.enqueue({
        type: "finish",
        finishReason: stopFinishReason,
        usage: zeroUsage,
      });
      controller.close();
    },
  });
}

function emittedText(parts: LanguageModelV4StreamPart[]): string {
  return parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("");
}

describe("GLM terminal rejection and generic JSON recovery", () => {
  it("does not execute JSON nested in a rejected GLM envelope through wrapGenerate", async () => {
    // Given: a canonical GLM envelope that the GLM parser rejects, followed by benign JSON text.
    const onError = vi.fn();

    // When: the real generate wrapper parses the provider response.
    const result = await wrapGenerate({
      protocol: glm5Protocol(),
      doGenerate: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: REJECTED_WITH_ADJACENT_TEXT }],
        finishReason: stopFinishReason,
        usage: zeroUsage,
        warnings: [],
      }),
      params: params({ onError }),
    });

    // Then: rejection remains terminal and only the adjacent benign text survives.
    expect(result.content).toEqual([
      { type: "text", text: `\n${BENIGN_JSON_TEXT}` },
    ]);
    expect(onError).toHaveBeenCalledWith(
      "Could not parse GLM-5.2 tool call.",
      expect.objectContaining({ dropReason: "malformed-glm5-tool-call" })
    );
  });

  it("does not execute raw fallback JSON from a rejected GLM envelope through wrapStream", async () => {
    // Given: the same rejected envelope is explicitly emitted as raw fallback text.
    const onError = vi.fn();

    // When: the real stream wrapper parses and applies generic JSON recovery.
    const result = await wrapStream({
      protocol: glm5Protocol(),
      doStream: vi.fn().mockResolvedValue({
        stream: providerStream(REJECTED_WITH_ADJACENT_TEXT),
      }),
      doGenerate: vi.fn(),
      params: params({ emitRawToolCallTextOnError: true, onError }),
    });
    const parts = await convertReadableStreamToArray(result.stream);

    // Then: no fallback tool call is emitted; requested raw text stays ordinary text.
    expect(parts.some((part) => part.type === "tool-call")).toBe(false);
    expect(emittedText(parts)).toBe(REJECTED_WITH_ADJACENT_TEXT);
    expect(onError).toHaveBeenCalledWith(
      "Could not parse streaming GLM-5.2 tool call.",
      expect.objectContaining({ dropReason: "malformed-glm5-tool-call" })
    );
  });

  it("keeps standalone JSON recovery through wrapGenerate", async () => {
    // Given: a standalone known-tool JSON payload without a GLM envelope.
    // When: the real generate wrapper applies generic recovery.
    const result = await wrapGenerate({
      protocol: glm5Protocol(),
      doGenerate: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: STANDALONE_JSON_CALL }],
        finishReason: stopFinishReason,
        usage: zeroUsage,
        warnings: [],
      }),
      params: params(),
    });

    // Then: legitimate protocol-independent recovery still emits ping.
    expect(result.content).toEqual([
      expect.objectContaining({
        type: "tool-call",
        toolName: "ping",
        input: "{}",
      }),
    ]);
  });

  it("keeps standalone JSON recovery through wrapStream", async () => {
    // Given: the same standalone known-tool JSON payload in a provider stream.
    // When: the real stream wrapper applies generic recovery.
    const result = await wrapStream({
      protocol: glm5Protocol(),
      doStream: vi.fn().mockResolvedValue({
        stream: providerStream(STANDALONE_JSON_CALL),
      }),
      doGenerate: vi.fn(),
      params: params(),
    });
    const parts = await convertReadableStreamToArray(result.stream);

    // Then: stream parity retains legitimate standalone recovery.
    expect(parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool-call",
          toolName: "ping",
          input: "{}",
        }),
      ])
    );
  });
});
