import type {
  LanguageModelV4Citation,
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import type { TCMCoreProtocol } from "../../core/protocols/protocol-interface";
import { originalToolsSchema } from "../../core/utils/provider-options";
import { wrapGenerate } from "../../generate-handler";
import { stopFinishReason, zeroUsage } from "../test-helpers";

// Protocol parsers rebuild text parts from the generated text, which used to
// drop the citations and provider metadata attached to the provider's part.

type TextContent = Extract<LanguageModelV4Content, { type: "text" }>;

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "get_weather",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
];

const source = {
  type: "source",
  sourceType: "url",
  id: "src-1",
  url: "https://example.com/seoul",
} as const;

async function generate(
  content: LanguageModelV4Content[],
  protocol: TCMCoreProtocol = hermesProtocol()
) {
  const result = await wrapGenerate({
    protocol,
    doGenerate: vi.fn().mockResolvedValue({
      content,
      finishReason: stopFinishReason,
      usage: zeroUsage,
      warnings: [],
    }),
    params: {
      providerOptions: {
        toolCallMiddleware: {
          originalTools: originalToolsSchema.encode(tools),
        },
      },
    },
  });
  return result.content as LanguageModelV4Content[];
}

describe("wrapGenerate preserves text citations", () => {
  it("restores provider citations when a custom parser returns an empty array", async () => {
    const citations = [{ source, startIndex: 0, endIndex: 5 }];
    const text = "Seoul is sunny.";
    const content = await generate([{ type: "text", text, citations }], {
      ...hermesProtocol(),
      parseGeneratedText: ({ text: parsedText }) => [
        { type: "text", text: parsedText, citations: [] },
      ],
    });

    expect(content).toEqual([{ type: "text", text, citations }]);
  });

  it("keeps citations and provider metadata on text without tool calls", async () => {
    const citations: LanguageModelV4Citation[] = [
      { source, startIndex: 0, endIndex: 5, citedText: "Seoul report" },
    ];
    const providerMetadata = { openai: { itemId: "msg_1" } };

    const content = await generate([
      { type: "text", text: "Seoul is sunny.", citations, providerMetadata },
    ]);

    expect(content).toEqual([
      { type: "text", text: "Seoul is sunny.", citations, providerMetadata },
    ]);
  });

  it("re-anchors offsets to the text segments around a tool call", async () => {
    const before = "Seoul first. ";
    const call =
      '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call>';
    const after = " Busan later.";
    const text = before + call + after;
    const busanStart = text.indexOf("Busan");

    const content = await generate([
      {
        type: "text",
        text,
        citations: [
          { source, startIndex: 0, endIndex: 5 },
          { source, startIndex: busanStart, endIndex: busanStart + 5 },
          // Spans the tool-call markup the parser removes.
          { source, startIndex: 0, endIndex: text.length },
          // No offsets at all.
          { source, citedText: "whole answer" },
        ],
        providerMetadata: { openai: { itemId: "msg_1" } },
      },
    ]);

    expect(content.map((part) => part.type)).toEqual([
      "text",
      "tool-call",
      "text",
    ]);
    const [first, , last] = content as TextContent[];

    expect(first.citations).toHaveLength(1);
    const [seoul] = first.citations ?? [];
    expect(first.text.slice(seoul.startIndex, seoul.endIndex)).toBe("Seoul");

    const [busan, spanning, unanchored] = last.citations ?? [];
    expect(last.text.slice(busan.startIndex, busan.endIndex)).toBe("Busan");
    expect(spanning).toEqual({ source });
    expect(unanchored).toEqual({ source, citedText: "whole answer" });

    // The provider block was split, so its block-level metadata is not
    // duplicated onto the pieces.
    expect(first.providerMetadata).toBeUndefined();
    expect(last.providerMetadata).toBeUndefined();
  });

  it("returns parsed text unchanged when there is nothing to carry", async () => {
    const content = await generate([{ type: "text", text: "Plain answer." }]);

    expect(content).toEqual([{ type: "text", text: "Plain answer." }]);
  });

  it("does not anchor a citation inside removed markup to repeated surviving text", async () => {
    const call =
      '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call>';
    const startIndex = call.indexOf("Seoul");
    const content = await generate([
      {
        type: "text",
        text: `${call}Seoul`,
        citations: [{ source, startIndex, endIndex: startIndex + 5 }],
      },
    ]);

    expect(content.find((part) => part.type === "text")).toEqual({
      type: "text",
      text: "Seoul",
      citations: [{ source }],
    });
  });

  it("retains unanchored citations when all text becomes a tool call", async () => {
    const content = await generate([
      {
        type: "text",
        text: '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call>',
        citations: [{ source, startIndex: 0, endIndex: 5 }],
      },
    ]);

    expect(content.filter((part) => part.type === "tool-call")).toHaveLength(1);
    expect(content.find((part) => part.type === "text")).toEqual({
      type: "text",
      text: "",
      citations: [{ source }],
    });
  });
});
