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

  it("uses the first parseable JSON text part for forced tool choice", async () => {
    const doGenerate = vi.fn().mockResolvedValue({
      content: [
        { type: "text", text: "I will call the tool now." },
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

    expect(result.content.at(-1)).toMatchObject({
      type: "tool-call",
      toolName: "do",
      input: '{"x":1}',
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

  it("preserves a string length finish reason instead of masking truncation", async () => {
    const doGenerate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"name":"do","arguments":{}}' }],
      finishReason: "length",
      warnings: [],
    });

    const result = await wrapGenerate({
      protocol: dummyProtocol(),
      doGenerate,
      params: { providerOptions: forcedChoiceProviderOptions },
    });

    expect(result.finishReason).toEqual({
      unified: "length",
      raw: "length",
    });
  });

  it("redacts debugSummary originalText for prototype-sensitive forced toolChoice payloads", async () => {
    const debugSummary: { originalText?: string; toolCalls?: string } = {};
    const doGenerate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: '{"name":"do","arguments":{"constructor":{"polluted":true},"x":1}}',
        },
      ],
      finishReason: { unified: "stop", raw: "stop" },
      warnings: [],
    });

    await wrapGenerate({
      protocol: dummyProtocol(),
      doGenerate,
      params: {
        providerOptions: {
          toolCallMiddleware: {
            ...forcedChoiceProviderOptions.toolCallMiddleware,
            debugSummary,
          },
        },
      },
    });

    expect(debugSummary.originalText).toBe("[redacted sensitive tool call]");
    expect(JSON.stringify(debugSummary)).not.toContain("constructor");
    expect(JSON.stringify(debugSummary)).not.toContain("polluted");
  });
});
