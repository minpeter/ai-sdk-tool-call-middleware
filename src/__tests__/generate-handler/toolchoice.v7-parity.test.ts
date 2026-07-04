import { describe, expect, it, vi } from "vitest";
import { wrapGenerate } from "../../generate-handler";
import { dummyProtocol } from "../fixtures/dummy-protocol";

const forcedChoiceProviderOptions = {
  toolCallMiddleware: {
    toolChoice: { type: "required" as const },
    originalTools: [{ name: "do", inputSchema: '{"type":"object"}' }],
  },
};

describe("wrapGenerate forced tool choice v7 parity", () => {
  it("keeps reasoning content alongside the forced tool call", async () => {
    const doGenerate = vi.fn().mockResolvedValue({
      content: [
        { type: "reasoning", text: "let me think" },
        { type: "text", text: '{"name":"do","arguments":{"x":1}}' },
      ],
      finishReason: { unified: "stop", raw: "stop" },
      warnings: [],
    });

    const result = await wrapGenerate({
      protocol: dummyProtocol(),
      doGenerate,
      params: { providerOptions: forcedChoiceProviderOptions },
    });

    expect(result.content.map((part: { type: string }) => part.type)).toEqual([
      "reasoning",
      "tool-call",
    ]);
    expect(result.content[1]).toMatchObject({
      type: "tool-call",
      toolName: "do",
      input: '{"x":1}',
    });
    expect(result.finishReason).toEqual({
      unified: "tool-calls",
      raw: "stop",
    });
  });

  it("preserves a length finish reason instead of masking truncation", async () => {
    const doGenerate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"name":"do","arg' }],
      finishReason: { unified: "length", raw: "max_tokens" },
      warnings: [],
    });

    const result = await wrapGenerate({
      protocol: dummyProtocol(),
      doGenerate,
      params: { providerOptions: forcedChoiceProviderOptions },
    });

    expect(result.finishReason).toEqual({
      unified: "length",
      raw: "max_tokens",
    });
    expect(result.content.at(-1)).toMatchObject({
      type: "tool-call",
      toolName: "unknown",
    });
  });
});
