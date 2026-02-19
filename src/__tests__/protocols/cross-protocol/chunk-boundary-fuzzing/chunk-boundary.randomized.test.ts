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
  describe("hermesProtocol", () => {
    for (const testCase of hermesProtocolTestCases) {
      describe(testCase.name, () => {
        it.each(
          Array.from({ length: FUZZ_ITERATIONS }, (_, i) => i)
        )("produces consistent results with random split seed %i", async (seed) => {
          const protocol = hermesProtocol();
          const transformer = protocol.createStreamParser({ tools: [] });
          const chunks = randomChunkSplit(testCase.input, 1, 8, seed);
          const stream = createChunkedStream(chunks);

          const output = await convertReadableStreamToArray(
            pipeWithTransformer(stream, transformer)
          );

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
        });
      });
    }
  });

  describe("morphXmlProtocol", () => {
    for (const testCase of xmlTestCases) {
      describe(testCase.name, () => {
        it.each(
          Array.from({ length: FUZZ_ITERATIONS }, (_, i) => i)
        )("produces consistent results with random split seed %i", async (seed) => {
          const protocol = morphXmlProtocol();
          const transformer = protocol.createStreamParser({
            tools: morphXmlTools,
          });
          const chunks = randomChunkSplit(testCase.input, 1, 8, seed);
          const stream = createChunkedStream(chunks);

          const output = await convertReadableStreamToArray(
            pipeWithTransformer(stream, transformer)
          );

          const parsedTools = extractToolCalls(output);
          expect(parsedTools).toEqual(testCase.expectedTools);

          if (testCase.expectedTextContains) {
            const text = extractText(output);
            for (const expected of testCase.expectedTextContains) {
              expect(text).toContain(expected);
            }
          }
        });
      });
    }
  });

  describe("qwen3CoderProtocol", () => {
    for (const testCase of qwen3CoderProtocolTestCases) {
      describe(testCase.name, () => {
        it.each(
          Array.from({ length: FUZZ_ITERATIONS }, (_, i) => i)
        )("produces consistent results with random split seed %i", async (seed) => {
          const protocol = qwen3CoderProtocol();
          const transformer = protocol.createStreamParser({ tools: [] });
          const chunks = randomChunkSplit(testCase.input, 1, 8, seed);
          const stream = createChunkedStream(chunks);

          const output = await convertReadableStreamToArray(
            pipeWithTransformer(stream, transformer)
          );

          const tools = extractToolCalls(output);
          expect(tools).toEqual(testCase.expectedTools);

          const text = extractText(output);

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
        });
      });
    }
  });
});
