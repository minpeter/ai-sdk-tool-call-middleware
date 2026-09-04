import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";

import { toolChoiceStream } from "../../stream-handler";
import { mockUsage } from "../test-helpers";

function contentStream(
  content: Array<{ readonly type: "text"; readonly text: string }>
) {
  const doGenerate = vi.fn().mockResolvedValue({
    content,
    usage: mockUsage(3, 5),
  });
  return toolChoiceStream({ doGenerate, tools: [] });
}

async function expectForcedCall(
  content: Array<{ readonly type: "text"; readonly text: string }>
): Promise<void> {
  const result = await contentStream(content);
  const chunks = await convertReadableStreamToArray(result.stream);
  expect(chunks.at(-2)).toMatchObject({
    type: "tool-call",
    toolName: "do",
    input: '{"x":1}',
  });
}

describe("toolChoiceStream v7 parity", () => {
  it("parses the JSON payload when reasoning precedes the text part", async () => {
    const doGenerate = vi.fn().mockResolvedValue({
      content: [
        { type: "reasoning", text: "let me think" },
        { type: "text", text: '{"name":"do","arguments":{"x":1}}' },
      ],
      usage: mockUsage(3, 5),
    });

    const { stream } = await toolChoiceStream({ doGenerate, tools: [] });
    const chunks = await convertReadableStreamToArray(stream);

    expect(chunks.map((c) => c.type)).toEqual([
      "stream-start",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "finish",
    ]);
    expect(chunks[2]).toMatchObject({
      type: "reasoning-delta",
      delta: "let me think",
    });
    expect(chunks.at(-2)).toMatchObject({ type: "tool-call", toolName: "do" });
  });

  it("skips empty text parts before the toolChoice JSON payload", async () => {
    await expectForcedCall([
      { type: "text", text: "" },
      { type: "text", text: "   " },
      { type: "text", text: '{"name":"do","arguments":{"x":1}}' },
    ]);
  });

  it("uses the first parseable JSON text part for forced tool choice", async () => {
    await expectForcedCall([
      { type: "text", text: "I will call the tool now." },
      { type: "text", text: '{"name":"do","arguments":{"x":1}}' },
    ]);
  });

  it("emits response-metadata when the generate result carries response info", async () => {
    const doGenerate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"name":"do","arguments":{}}' }],
      response: { id: "res-1", modelId: "m-1" },
    });

    const { stream } = await toolChoiceStream({ doGenerate, tools: [] });
    const chunks = await convertReadableStreamToArray(stream);

    expect(chunks[1]).toMatchObject({
      type: "response-metadata",
      id: "res-1",
      modelId: "m-1",
    });
  });

  it("preserves a length finish reason instead of masking truncation", async () => {
    const truncatedContent = { type: "text", text: '{"name":"do","arg' };
    const lengthReason = { unified: "length", raw: "max_tokens" };
    const doGenerate = vi.fn();
    doGenerate.mockResolvedValue({
      finishReason: lengthReason,
      content: [truncatedContent],
    });

    const { stream } = await toolChoiceStream({ doGenerate, tools: [] });
    const chunks = await convertReadableStreamToArray(stream);

    const finalChunk = chunks.at(-1);
    expect(finalChunk).toMatchObject({
      type: "finish",
      finishReason: { unified: "length", raw: "max_tokens" },
    });
  });

  it("reports missing text content through onError instead of failing silently", async () => {
    const onError = vi.fn();
    const doGenerate = vi.fn().mockResolvedValue({
      content: [{ type: "reasoning", text: "hmm" }],
    });

    const { stream } = await toolChoiceStream({
      doGenerate,
      tools: [],
      options: { onError },
    });
    const chunks = await convertReadableStreamToArray(stream);

    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("no text content"),
      expect.any(Object)
    );
    const toolCall = chunks.find((c) => c.type === "tool-call");
    expect(toolCall).toMatchObject({ toolName: "unknown", input: "{}" });
  });
});
