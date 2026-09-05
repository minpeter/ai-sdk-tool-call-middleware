import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import {
  createChunkedStream,
  pipeWithTransformer,
} from "../../../test-helpers";
import {
  charByCharSplit,
  extractText,
  extractToolCalls,
  morphXmlTools,
} from "./randomized.shared";

type Protocol =
  | ReturnType<typeof hermesProtocol>
  | ReturnType<typeof morphXmlProtocol>
  | ReturnType<typeof qwen3CoderProtocol>;

interface CharacterCase {
  readonly expectedTextContains?: readonly string[];
  readonly expectedTextNotContains?: readonly string[];
  readonly expectedTools: ReturnType<typeof extractToolCalls>;
  readonly input: string;
  readonly name: string;
}

interface CharacterSuite {
  readonly cases: readonly CharacterCase[];
  readonly createProtocol: () => Protocol;
  readonly name: string;
  readonly tools: LanguageModelV4FunctionTool[];
}

async function assertCharacterCase(
  testCase: CharacterCase,
  suite: CharacterSuite
): Promise<void> {
  const transformer = suite.createProtocol().createStreamParser({
    tools: suite.tools,
  });
  const stream = createChunkedStream(charByCharSplit(testCase.input));
  const reader = pipeWithTransformer(stream, transformer).getReader();
  const output: LanguageModelV4StreamPart[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    output.push(result.value);
  }

  expect(extractToolCalls(output)).toEqual(testCase.expectedTools);
  const text = extractText(output);
  for (const expected of testCase.expectedTextContains ?? []) {
    expect(text).toContain(expected);
  }
  for (const expected of testCase.expectedTextNotContains ?? []) {
    expect(text).not.toContain(expected);
  }
}

const suites: readonly CharacterSuite[] = [
  {
    name: "hermesProtocol",
    createProtocol: hermesProtocol,
    tools: [],
    cases: [
      {
        name: "parses tool call when streamed char-by-char",
        input:
          '<tool_call>{"name":"test","arguments":{"value":"hello"}}</tool_call>',
        expectedTools: [{ toolName: "test", input: { value: "hello" } }],
      },
      {
        name: "handles text + tool call + text char-by-char",
        input:
          'Before <tool_call>{"name":"x","arguments":{}}</tool_call> After',
        expectedTools: [{ toolName: "x", input: {} }],
        expectedTextContains: ["Before", "After"],
        expectedTextNotContains: ["<tool_call>"],
      },
      {
        name: "handles multiple tool calls char-by-char",
        input:
          '<tool_call>{"name":"a","arguments":{"n":1}}</tool_call><tool_call>{"name":"b","arguments":{"n":2}}</tool_call>',
        expectedTools: [
          { toolName: "a", input: { n: 1 } },
          { toolName: "b", input: { n: 2 } },
        ],
      },
    ],
  },
  {
    name: "morphXmlProtocol",
    createProtocol: morphXmlProtocol,
    tools: morphXmlTools,
    cases: [
      {
        name: "parses XML tool call when streamed char-by-char",
        input: "<get_weather><city>Seoul</city></get_weather>",
        expectedTools: [{ toolName: "get_weather", input: { city: "Seoul" } }],
      },
      {
        name: "handles nested params char-by-char",
        input:
          "<search><query>test query</query><limit>5</limit><offset>0</offset></search>",
        expectedTools: [
          {
            toolName: "search",
            input: { query: "test query", limit: 5, offset: 0 },
          },
        ],
      },
    ],
  },
  {
    name: "qwen3CoderProtocol",
    createProtocol: qwen3CoderProtocol,
    tools: [],
    cases: [
      {
        name: "parses Qwen3CoderToolParser tool call when streamed char-by-char",
        input:
          "<tool_call><function=test><parameter=value>hello</parameter></function></tool_call>",
        expectedTools: [{ toolName: "test", input: { value: "hello" } }],
      },
      {
        name: "handles text + Qwen3CoderToolParser tool call + text char-by-char",
        input:
          "Before <tool_call><function=x><parameter=a>1</parameter></function></tool_call> After",
        expectedTools: [{ toolName: "x", input: { a: "1" } }],
        expectedTextContains: ["Before", "After"],
        expectedTextNotContains: ["<tool_call>"],
      },
      {
        name: "handles multiple Qwen3CoderToolParser tool calls char-by-char",
        input:
          "<tool_call><function=a><parameter=n>1</parameter></function></tool_call><tool_call><function=b><parameter=n>2</parameter></function></tool_call>",
        expectedTools: [
          { toolName: "a", input: { n: "1" } },
          { toolName: "b", input: { n: "2" } },
        ],
      },
    ],
  },
];

describe("Single-character chunk streaming", () => {
  for (const suite of suites) {
    describe(suite.name, () => {
      for (const testCase of suite.cases) {
        it(testCase.name, async () => {
          await assertCharacterCase(testCase, suite);
        });
      }
    });
  }
});
