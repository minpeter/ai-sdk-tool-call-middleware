import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";

import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import {
  createChunkedStream,
  pipeWithTransformer,
} from "../../../test-helpers";
import {
  extractText,
  extractToolCalls,
  FUZZ_ITERATIONS,
  hermesProtocolTestCases,
  morphXmlTools,
  qwen3CoderProtocolTestCases,
  randomChunkSplit,
  xmlTestCases,
} from "./randomized.shared";

describe("Random chunk boundary fuzzing", () => {
  interface FuzzCase {
    expectedText?: string;
    expectedTextContains?: readonly string[];
    expectedTextNotContains?: readonly string[];
    expectedTools: ReturnType<typeof extractToolCalls>;
    input: string;
    name: string;
  }

  function assertFuzzResult(
    testCase: FuzzCase,
    output: LanguageModelV4StreamPart[]
  ) {
    const tools = extractToolCalls(output);
    expect(tools).toEqual(testCase.expectedTools);

    const text = extractText(output);
    if (testCase.expectedText !== undefined) {
      expect(text.trim()).toBe(testCase.expectedText);
    }
    if (testCase.expectedTextContains) {
      for (const expected of testCase.expectedTextContains) {
        expect(text).toContain(expected);
      }
    }
    if (testCase.expectedTextNotContains) {
      for (const notExpected of testCase.expectedTextNotContains) {
        expect(text).not.toContain(notExpected);
      }
    }
  }

  interface FuzzSuite {
    readonly createProtocol: () =>
      | ReturnType<typeof hermesProtocol>
      | ReturnType<typeof morphXmlProtocol>
      | ReturnType<typeof qwen3CoderProtocol>;
    readonly name: string;
    readonly testCases: readonly FuzzCase[];
    readonly tools: LanguageModelV4FunctionTool[];
  }

  function describeFuzzSuite(suite: FuzzSuite) {
    describe(suite.name, () => {
      for (const testCase of suite.testCases) {
        describe(testCase.name, () => {
          it.each(Array.from({ length: FUZZ_ITERATIONS }, (_, i) => i))(
            "produces consistent results with random split seed %i",
            async (seed) => {
              const protocol = suite.createProtocol();
              const transformer = protocol.createStreamParser({
                tools: suite.tools,
              });
              const chunks = randomChunkSplit(testCase.input, 1, 8, seed);
              const stream = createChunkedStream(chunks);

              const output = await convertReadableStreamToArray(
                pipeWithTransformer(stream, transformer)
              );

              assertFuzzResult(testCase, output);
            }
          );
        });
      }
    });
  }

  describeFuzzSuite({
    name: "hermesProtocol",
    createProtocol: hermesProtocol,
    tools: [],
    testCases: hermesProtocolTestCases,
  });
  describeFuzzSuite({
    name: "morphXmlProtocol",
    createProtocol: morphXmlProtocol,
    tools: morphXmlTools,
    testCases: xmlTestCases,
  });
  describeFuzzSuite({
    name: "qwen3CoderProtocol",
    createProtocol: qwen3CoderProtocol,
    tools: [],
    testCases: qwen3CoderProtocolTestCases,
  });
});
