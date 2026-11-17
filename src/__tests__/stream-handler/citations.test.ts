import type {
  LanguageModelV4Citation,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { glm5Protocol } from "../../core/protocols/glm5-protocol";
import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { kExaone2Protocol } from "../../core/protocols/k-exaone-2-protocol";
import { kExaone236BProtocol } from "../../core/protocols/k-exaone-236b-protocol";
import { morphXmlProtocol } from "../../core/protocols/morph-xml-protocol";
import type { TCMCoreProtocol } from "../../core/protocols/protocol-interface";
import { qwen3CoderProtocol } from "../../core/protocols/qwen3coder-protocol";
import { yamlXmlProtocol } from "../../core/protocols/yaml-xml-protocol";
import { originalToolsSchema } from "../../core/utils/provider-options";
import { wrapStream } from "../../stream-handler";
import { stopFinishReason, zeroUsage } from "../test-helpers";

// Citations ride on the provider's `text-end`. Protocol parsers drop that
// envelope because they re-segment text under their own ids, so the stream
// handler has to carry the citations over to the text block it publishes.

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

const protocols: Array<{ name: string; protocol: TCMCoreProtocol }> = [
  { name: "hermes", protocol: hermesProtocol() },
  { name: "morph-xml", protocol: morphXmlProtocol() },
  { name: "yaml-xml", protocol: yamlXmlProtocol() },
  { name: "qwen3coder", protocol: qwen3CoderProtocol() },
  { name: "glm5", protocol: glm5Protocol() },
  { name: "k-exaone-2", protocol: kExaone2Protocol() },
  { name: "k-exaone-236b", protocol: kExaone236BProtocol() },
];

async function runStream(
  protocol: TCMCoreProtocol,
  parts: LanguageModelV4StreamPart[]
) {
  const { stream } = await wrapStream({
    protocol,
    doGenerate: () => {
      throw new Error("doGenerate must not be called");
    },
    doStream: () =>
      Promise.resolve({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            for (const part of parts) {
              controller.enqueue(part);
            }
            controller.close();
          },
        }),
      }),
    params: {
      providerOptions: {
        toolCallMiddleware: {
          originalTools: originalToolsSchema.encode(tools),
        },
      },
    },
  });
  return convertReadableStreamToArray(stream);
}

function textBlock(
  id: string,
  text: string,
  citations?: LanguageModelV4Citation[]
): LanguageModelV4StreamPart[] {
  return [
    { type: "text-start", id },
    ...(text.match(/[\s\S]{1,4}/g) ?? []).map(
      (delta): LanguageModelV4StreamPart => ({ type: "text-delta", id, delta })
    ),
    { type: "text-end", id, ...(citations ? { citations } : {}) },
  ];
}

const finish: LanguageModelV4StreamPart = {
  type: "finish",
  finishReason: stopFinishReason,
  usage: zeroUsage,
};

/** Text of each published block, paired with the citations on its text-end. */
function publishedBlocks(output: LanguageModelV4StreamPart[]) {
  const blocks = new Map<
    string,
    { text: string; citations?: LanguageModelV4Citation[] }
  >();
  for (const part of output) {
    if (part.type === "text-start") {
      blocks.set(part.id, { text: "" });
    } else if (part.type === "text-delta") {
      const block = blocks.get(part.id);
      if (block) {
        block.text += part.delta;
      }
    } else if (part.type === "text-end") {
      const block = blocks.get(part.id);
      if (block && part.citations) {
        block.citations = part.citations;
      }
    }
  }
  return [...blocks.values()];
}

describe("wrapStream preserves text citations", () => {
  for (const { name, protocol } of protocols) {
    it(`${name}: keeps citations and offsets on plain text`, async () => {
      const text = "Seoul is sunny today.";
      const citation: LanguageModelV4Citation = {
        source,
        startIndex: 0,
        endIndex: 5,
        citedText: "Seoul weather report",
      };

      const output = await runStream(protocol, [
        ...textBlock("provider-text", text, [citation]),
        finish,
      ]);

      expect(publishedBlocks(output)).toEqual([
        { text, citations: [citation] },
      ]);
      expect(output.some((part) => part.type === "raw")).toBe(false);
      expect(output.at(-1)).toEqual(finish);
    });

    it(`${name}: re-anchors offsets when the block follows merged text`, async () => {
      const first = "Intro. ";
      const second = "Seoul is sunny.";

      const output = await runStream(protocol, [
        ...textBlock("provider-text-1", first),
        ...textBlock("provider-text-2", second, [
          { source, startIndex: 0, endIndex: 5 },
        ]),
        finish,
      ]);

      const blocks = publishedBlocks(output);
      expect(blocks.map((block) => block.text).join("")).toBe(first + second);
      const cited = blocks.filter((block) => block.citations);
      expect(cited).toHaveLength(1);
      const [citation] = cited[0].citations ?? [];
      expect(cited[0].text.slice(citation.startIndex, citation.endIndex)).toBe(
        "Seoul"
      );
    });

    it(`${name}: keeps citations when the text ends with a tool call`, async () => {
      const call = protocol.formatToolCall({
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "get_weather",
        input: JSON.stringify({ city: "Seoul" }),
      });
      const text = `Checking Seoul.\n${call}`;
      // The cited range covers tool-call markup the parser removes, so the
      // offsets cannot survive; the source must.
      const citation: LanguageModelV4Citation = {
        source,
        startIndex: text.length - 4,
        endIndex: text.length,
      };

      const output = await runStream(protocol, [
        ...textBlock("provider-text", text, [citation]),
        finish,
      ]);

      expect(output.filter((part) => part.type === "tool-call")).toHaveLength(
        1
      );
      const citations = publishedBlocks(output).flatMap(
        (block) => block.citations ?? []
      );
      expect(citations).toEqual([{ source }]);
      expect(output.some((part) => part.type === "raw")).toBe(false);
      expect(output.at(-1)?.type).toBe("finish");
    });
  }

  it("does not add text blocks when the provider sends no citations", async () => {
    const output = await runStream(hermesProtocol(), [
      ...textBlock("provider-text", "Plain answer."),
      finish,
    ]);

    expect(publishedBlocks(output)).toEqual([{ text: "Plain answer." }]);
  });

  it("does not duplicate citations preserved by a custom protocol", async () => {
    const protocol = {
      ...hermesProtocol(),
      createStreamParser: () =>
        new TransformStream<
          LanguageModelV4StreamPart,
          LanguageModelV4StreamPart
        >(),
    };
    const citations = [{ source, startIndex: 0, endIndex: 5 }];
    const output = await runStream(protocol, [
      ...textBlock("provider-text", "Seoul is sunny.", citations),
      finish,
    ]);

    expect(publishedBlocks(output)).toEqual([
      { text: "Seoul is sunny.", citations },
    ]);
  });

  it("does not anchor citations to repeated text in removed tool markup", async () => {
    const call =
      '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call>';
    const startIndex = call.indexOf("Seoul");
    const output = await runStream(hermesProtocol(), [
      ...textBlock("provider-text", `${call}Seoul`, [
        { source, startIndex, endIndex: startIndex + 5 },
      ]),
      finish,
    ]);

    expect(publishedBlocks(output)).toEqual([
      { text: "Seoul", citations: [{ source }] },
    ]);
  });

  it("does not attach late citations to an unrelated later text block", async () => {
    const call =
      '<tool_call>{"name":"get_weather","arguments":{"city":"Busan"}}</tool_call>';
    const output = await runStream(hermesProtocol(), [
      ...textBlock("first", `Seoul${call}`, [
        { source, startIndex: 0, endIndex: 5 },
      ]),
      ...textBlock("second", "Seoul"),
      finish,
    ]);

    const citedBlocks = publishedBlocks(output).filter(
      (block) => block.citations
    );
    expect(citedBlocks).toEqual([{ text: "", citations: [{ source }] }]);
  });

  it.each([
    { startIndex: -1, endIndex: 5 },
    { startIndex: 1.5, endIndex: 5 },
    { startIndex: Number.NaN, endIndex: 5 },
  ])("drops invalid citation offsets: %j", async (offsets) => {
    const output = await runStream(hermesProtocol(), [
      ...textBlock("provider-text", "Seoul", [{ source, ...offsets }]),
      finish,
    ]);

    expect(publishedBlocks(output)).toEqual([
      { text: "Seoul", citations: [{ source }] },
    ]);
  });
});
