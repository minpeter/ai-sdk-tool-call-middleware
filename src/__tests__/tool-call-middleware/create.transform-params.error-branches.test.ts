import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4ProviderTool,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { createToolMiddleware } from "../../tool-call-middleware";
import {
  requireTransformParams,
  stopFinishReason,
  zeroUsage,
} from "../test-helpers";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

const notFoundError = /not found/;
const providerDefinedError = /Provider-defined tools/;
const requiredWithoutToolsError =
  /Tool choice type 'required' is set, but no tools are provided/;
const requiredWithoutFunctionToolsError = /no function tools are provided/;

describe("createToolMiddleware transformParams error branches", () => {
  const generateResult = {
    content: [],
    finishReason: stopFinishReason,
    usage: zeroUsage,
    warnings: [],
  } satisfies LanguageModelV4GenerateResult;
  const streamResult = {
    stream: new ReadableStream(),
  } satisfies LanguageModelV4StreamResult;
  const model: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "test",
    modelId: "test",
    supportedUrls: {},
    doGenerate: async () => generateResult,
    doStream: async () => streamResult,
  };
  const providerTool = {
    type: "provider",
    id: "test.x",
    name: "x",
    args: {},
  } satisfies LanguageModelV4ProviderTool;
  const mw = createToolMiddleware({
    protocol: hermesProtocol,
    toolSystemPromptTemplate: (t) => `T:${t}`,
  });

  const errorCases: readonly {
    readonly expected: RegExp;
    readonly name: string;
    readonly toolChoice: LanguageModelV4CallOptions["toolChoice"];
    readonly tools: LanguageModelV4CallOptions["tools"];
  }[] = [
    {
      name: "throws when specific tool not found",
      tools: [],
      toolChoice: { type: "tool", toolName: "missing" },
      expected: notFoundError,
    },
    {
      name: "throws when provider-defined tool is selected",
      tools: [providerTool],
      toolChoice: { type: "tool", toolName: "x" },
      expected: providerDefinedError,
    },
    {
      name: "throws when required toolChoice is set but no tools are provided",
      tools: [],
      toolChoice: { type: "required" },
      expected: requiredWithoutToolsError,
    },
    {
      name: "throws when required toolChoice is set but tools are provider-defined only",
      tools: [providerTool],
      toolChoice: { type: "required" },
      expected: requiredWithoutFunctionToolsError,
    },
  ];

  for (const testCase of errorCases) {
    it(testCase.name, async () => {
      const transformParams = requireTransformParams(mw.transformParams);
      await expect(
        transformParams({
          type: "generate",
          params: {
            prompt: [],
            tools: testCase.tools,
            toolChoice: testCase.toolChoice,
          },
          model,
        })
      ).rejects.toThrow(testCase.expected);
    });
  }
});
