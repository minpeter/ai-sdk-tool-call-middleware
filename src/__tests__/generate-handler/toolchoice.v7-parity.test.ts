import type {
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { wrapGenerate } from "../../generate-handler";
import { dummyProtocol } from "../fixtures/dummy-protocol";

type ProviderOptions = NonNullable<
  Parameters<typeof wrapGenerate>[0]["params"]["providerOptions"]
>;

const forcedChoiceProviderOptions: ProviderOptions = {
  toolCallMiddleware: {
    toolChoice: { type: "required" },
    originalTools: [{ name: "do", inputSchema: '{"type":"object"}' }],
  },
};

type V7FinishReason = LanguageModelV4FinishReason | "length";

function runForcedChoice(
  content: LanguageModelV4Content[],
  finishReason: V7FinishReason
) {
  return wrapGenerate({
    protocol: dummyProtocol(),
    doGenerate: vi
      .fn()
      .mockResolvedValue({ content, finishReason, warnings: [] }),
    params: { providerOptions: forcedChoiceProviderOptions },
  });
}

const lengthCases: readonly {
  readonly content: LanguageModelV4Content[];
  readonly expected: LanguageModelV4FinishReason;
  readonly finishReason: V7FinishReason;
  readonly name: string;
  readonly expectsUnknownCall: boolean;
}[] = [
  {
    name: "preserves a length finish reason instead of masking truncation",
    content: [{ type: "text", text: '{"name":"do","arg' }],
    finishReason: { unified: "length", raw: "max_tokens" },
    expected: { unified: "length", raw: "max_tokens" },
    expectsUnknownCall: true,
  },
  {
    name: "preserves a string length finish reason instead of masking truncation",
    content: [{ type: "text", text: '{"name":"do","arguments":{}}' }],
    finishReason: "length",
    expected: { unified: "length", raw: "length" },
    expectsUnknownCall: false,
  },
];

describe("wrapGenerate forced tool choice v7 parity", () => {
  it("keeps reasoning content alongside the forced tool call", async () => {
    const result = await runForcedChoice(
      [
        { type: "reasoning", text: "let me think" },
        { type: "text", text: '{"name":"do","arguments":{"x":1}}' },
      ],
      { unified: "stop", raw: "stop" }
    );

    expect(result.content.map((part) => part.type)).toEqual([
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
    const result = await runForcedChoice(
      [
        { type: "text", text: "I will call the tool now." },
        { type: "text", text: '{"name":"do","arguments":{"x":1}}' },
      ],
      { unified: "stop", raw: "stop" }
    );

    expect(result.content.at(-1)).toMatchObject({
      type: "tool-call",
      toolName: "do",
      input: '{"x":1}',
    });
  });

  for (const scenario of lengthCases) {
    it(scenario.name, async () => {
      const result = await runForcedChoice(
        scenario.content,
        scenario.finishReason
      );
      expect(result.finishReason).toEqual(scenario.expected);
      if (scenario.expectsUnknownCall) {
        expect(result.content.at(-1)).toMatchObject({
          type: "tool-call",
          toolName: "unknown",
        });
      }
    });
  }

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

  it("redacts parse debug raw logging for prototype-sensitive forced toolChoice payloads", async () => {
    const previousDebug = process.env.DEBUG_PARSER_MW;
    process.env.DEBUG_PARSER_MW = "parse";
    const consoleSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    let logged = "";
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

    try {
      await wrapGenerate({
        protocol: dummyProtocol(),
        doGenerate,
        params: { providerOptions: forcedChoiceProviderOptions },
      });
      logged = JSON.stringify(consoleSpy.mock.calls);
    } finally {
      if (previousDebug === undefined) {
        delete process.env.DEBUG_PARSER_MW;
      } else {
        process.env.DEBUG_PARSER_MW = previousDebug;
      }
      consoleSpy.mockRestore();
    }

    expect(logged).toContain("[redacted sensitive tool call]");
    expect(logged).not.toContain("constructor");
    expect(logged).not.toContain("polluted");
  });
});
