import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import {
  createChunkedStream,
  pipeWithTransformer,
} from "../../../test-helpers";
import {
  extractToolCalls,
  randomChunkSplit,
  unicodeMorphXmlTools,
} from "./randomized.shared";

type UnicodeProtocol =
  | ReturnType<typeof hermesProtocol>
  | ReturnType<typeof morphXmlProtocol>;

interface UnicodeCase {
  readonly expectedTools: ReturnType<typeof extractToolCalls>;
  readonly input: string;
  readonly maxChunkSize: number;
  readonly name: string;
  readonly seed: number;
}

interface UnicodeSuite {
  readonly cases: readonly UnicodeCase[];
  readonly createProtocol: () => UnicodeProtocol;
  readonly name: string;
  readonly tools: LanguageModelV4FunctionTool[];
}

async function assertUnicodeCase(
  testCase: UnicodeCase,
  suite: UnicodeSuite
): Promise<void> {
  const transformer = suite.createProtocol().createStreamParser({
    tools: suite.tools,
  });
  const chunks = randomChunkSplit(
    testCase.input,
    1,
    testCase.maxChunkSize,
    testCase.seed
  );
  const output = await convertReadableStreamToArray(
    pipeWithTransformer(createChunkedStream(chunks), transformer)
  );

  expect(extractToolCalls(output)).toEqual(testCase.expectedTools);
}

const suites: readonly UnicodeSuite[] = [
  {
    name: "hermesProtocol",
    createProtocol: hermesProtocol,
    tools: [],
    cases: [
      {
        name: "handles Korean characters in arguments",
        input:
          '<tool_call>{"name":"search","arguments":{"query":"서울 날씨"}}</tool_call>',
        maxChunkSize: 5,
        seed: 42,
        expectedTools: [{ toolName: "search", input: { query: "서울 날씨" } }],
      },
      {
        name: "handles Japanese characters in arguments",
        input:
          '<tool_call>{"name":"translate","arguments":{"text":"こんにちは世界"}}</tool_call>',
        maxChunkSize: 4,
        seed: 123,
        expectedTools: [
          { toolName: "translate", input: { text: "こんにちは世界" } },
        ],
      },
      {
        name: "handles emoji in arguments",
        input:
          '<tool_call>{"name":"react","arguments":{"emoji":"🎉🚀💻"}}</tool_call>',
        maxChunkSize: 3,
        seed: 999,
        expectedTools: [{ toolName: "react", input: { emoji: "🎉🚀💻" } }],
      },
      {
        name: "handles mixed unicode and ASCII",
        input:
          '<tool_call>{"name":"search","arguments":{"query":"Hello 世界 🌍 Привет"}}</tool_call>',
        maxChunkSize: 6,
        seed: 777,
        expectedTools: [
          { toolName: "search", input: { query: "Hello 世界 🌍 Привет" } },
        ],
      },
      {
        name: "handles escaped characters in JSON",
        input:
          '<tool_call>{"name":"code","arguments":{"snippet":"function() {\\n  return \\"test\\";\\n}"}}</tool_call>',
        maxChunkSize: 5,
        seed: 555,
        expectedTools: [
          {
            toolName: "code",
            input: { snippet: 'function() {\n  return "test";\n}' },
          },
        ],
      },
      {
        name: "handles special XML-like characters in JSON strings",
        input:
          '<tool_call>{"name":"html","arguments":{"content":"<div class=\\"test\\">Hello</div>"}}</tool_call>',
        maxChunkSize: 4,
        seed: 333,
        expectedTools: [
          {
            toolName: "html",
            input: { content: '<div class="test">Hello</div>' },
          },
        ],
      },
    ],
  },
  {
    name: "morphXmlProtocol",
    createProtocol: morphXmlProtocol,
    tools: unicodeMorphXmlTools,
    cases: [
      {
        name: "handles Korean characters in XML content",
        input: "<search><query>서울 맛집 추천</query></search>",
        maxChunkSize: 4,
        seed: 42,
        expectedTools: [
          { toolName: "search", input: { query: "서울 맛집 추천" } },
        ],
      },
      {
        name: "handles Chinese characters in XML content",
        input: "<translate><text>你好世界</text><to>en</to></translate>",
        maxChunkSize: 5,
        seed: 88,
        expectedTools: [
          { toolName: "translate", input: { text: "你好世界", to: "en" } },
        ],
      },
      {
        name: "handles emoji in XML content",
        input: "<react><type>celebrate</type><emoji>🎊🎉✨</emoji></react>",
        maxChunkSize: 3,
        seed: 111,
        expectedTools: [
          { toolName: "react", input: { type: "celebrate", emoji: "🎊🎉✨" } },
        ],
      },
    ],
  },
];

describe("Unicode and special character boundary handling", () => {
  for (const suite of suites) {
    describe(suite.name, () => {
      for (const testCase of suite.cases) {
        it(testCase.name, async () => {
          await assertUnicodeCase(testCase, suite);
        });
      }
    });
  }
});
