import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

import type { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";

export type MorphXmlTools = Parameters<
  ReturnType<typeof morphXmlProtocol>["createStreamParser"]
>[0]["tools"];

export function seededRandom(seed: number): () => number {
  let current = seed;
  return () => {
    current = (current * 9301 + 49_297) % 233_280;
    return current / 233_280;
  };
}

export function randomChunkSplit(
  text: string,
  minSize = 1,
  maxSize = 10,
  seed = 0
): string[] {
  const random = seededRandom(seed);
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const size = Math.floor(random() * (maxSize - minSize + 1)) + minSize;
    chunks.push(text.slice(i, i + size));
    i += size;
  }
  return chunks;
}

export function charByCharSplit(text: string): string[] {
  return text.split("");
}

export function extractToolCalls(
  output: LanguageModelV3StreamPart[]
): Array<{ toolName: string; input: unknown }> {
  return output
    .filter(
      (
        c
      ): c is LanguageModelV3StreamPart & {
        type: "tool-call";
        toolName: string;
        input: string;
      } => c.type === "tool-call"
    )
    .map((c) => ({
      toolName: c.toolName,
      input: JSON.parse(c.input),
    }));
}

export function extractText(output: LanguageModelV3StreamPart[]): string {
  return output
    .filter(
      (
        c
      ): c is LanguageModelV3StreamPart & {
        type: "text-delta";
        delta: string;
      } => c.type === "text-delta"
    )
    .map((c) => c.delta)
    .join("");
}

export const FUZZ_ITERATIONS = 50;

export const hermesProtocolTestCases = [
  {
    name: "simple tool call",
    input:
      '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call>',
    expectedTools: [{ toolName: "get_weather", input: { city: "Seoul" } }],
    expectedText: "",
  },
  {
    name: "tool call with surrounding text",
    input:
      'Let me check. <tool_call>{"name":"search","arguments":{"q":"test"}}</tool_call> Done!',
    expectedTools: [{ toolName: "search", input: { q: "test" } }],
    expectedTextContains: ["Let me check.", "Done!"],
    expectedTextNotContains: ["<tool_call>", "</tool_call>", '"name"'],
  },
  {
    name: "multiple tool calls",
    input:
      '<tool_call>{"name":"a","arguments":{"x":1}}</tool_call> and <tool_call>{"name":"b","arguments":{"y":2}}</tool_call>',
    expectedTools: [
      { toolName: "a", input: { x: 1 } },
      { toolName: "b", input: { y: 2 } },
    ],
  },
];

export const xmlTestCases = [
  {
    name: "simple XML tool call",
    input: "<get_weather><city>Tokyo</city></get_weather>",
    expectedTools: [{ toolName: "get_weather", input: { city: "Tokyo" } }],
  },
  {
    name: "XML tool call with multiple params",
    input: "<search><query>hello world</query><limit>10</limit></search>",
    expectedTools: [
      { toolName: "search", input: { query: "hello world", limit: 10 } },
    ],
  },
  {
    name: "XML with surrounding text",
    input: "Checking... <get_weather><city>NYC</city></get_weather> found!",
    expectedTools: [{ toolName: "get_weather", input: { city: "NYC" } }],
    expectedTextContains: ["Checking...", "found!"],
  },
];

export const qwen3CoderProtocolTestCases = [
  {
    name: "simple Qwen3CoderToolParser tool call",
    input:
      "<tool_call><function=get_weather><parameter=city>Tokyo</parameter></function></tool_call>",
    expectedTools: [{ toolName: "get_weather", input: { city: "Tokyo" } }],
  },
  {
    name: "Qwen3CoderToolParser tool call missing </function>",
    input:
      "<tool_call><function=get_weather><parameter=city>Tokyo</parameter></tool_call>",
    expectedTools: [{ toolName: "get_weather", input: { city: "Tokyo" } }],
  },
  {
    name: "Qwen3CoderToolParser tool call with multiple params",
    input:
      "<tool_call><function=search><parameter=query>hello world</parameter><parameter=limit>10</parameter></function></tool_call>",
    expectedTools: [
      { toolName: "search", input: { query: "hello world", limit: "10" } },
    ],
  },
  {
    name: "Qwen3CoderToolParser with surrounding text",
    input:
      "Checking... <tool_call><function=get_weather><parameter=city>NYC</parameter></function></tool_call> found!",
    expectedTools: [{ toolName: "get_weather", input: { city: "NYC" } }],
    expectedTextContains: ["Checking...", "found!"],
    expectedTextNotContains: ["<tool_call>", "</tool_call>"],
  },
  {
    name: "Qwen3CoderToolParser multiple tool calls",
    input:
      "<tool_call><function=a><parameter=x>1</parameter></function></tool_call> and <tool_call><function=b><parameter=y>2</parameter></function></tool_call>",
    expectedTools: [
      { toolName: "a", input: { x: "1" } },
      { toolName: "b", input: { y: "2" } },
    ],
    expectedTextContains: [" and "],
    expectedTextNotContains: ["<tool_call>", "</tool_call>"],
  },
  {
    name: "Qwen3CoderToolParser multiple calls inside one tool_call",
    input:
      "<tool_call><function=alpha><parameter=x>1</parameter></function><function=beta><parameter=y>2</parameter><parameter=y>3</parameter></function></tool_call>",
    expectedTools: [
      { toolName: "alpha", input: { x: "1" } },
      { toolName: "beta", input: { y: ["2", "3"] } },
    ],
  },
];

export const morphXmlTools: MorphXmlTools = [
  {
    type: "function",
    name: "get_weather",
    inputSchema: { type: "object" },
  },
  { type: "function", name: "search", inputSchema: { type: "object" } },
];

export const unicodeMorphXmlTools: MorphXmlTools = [
  { type: "function", name: "search", inputSchema: { type: "object" } },
  { type: "function", name: "translate", inputSchema: { type: "object" } },
  { type: "function", name: "react", inputSchema: { type: "object" } },
];
