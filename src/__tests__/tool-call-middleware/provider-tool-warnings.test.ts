import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4ProviderTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { wrapGenerate } from "../../generate-handler";
import { wrapStream } from "../../stream-handler";
import { createToolMiddleware } from "../../tool-call-middleware";
import { dummyProtocol } from "../fixtures/dummy-protocol";
import { requireTransformParams, zeroUsage } from "../test-helpers";

const providerTool = {
  type: "provider",
  id: "openai.web_search",
  name: "web_search",
  args: {},
} satisfies LanguageModelV4ProviderTool;

const functionTool = {
  type: "function",
  name: "op",
  description: "desc",
  inputSchema: { type: "object" },
} satisfies LanguageModelV4FunctionTool;

const model: LanguageModelV4 = {
  specificationVersion: "v4",
  provider: "test",
  modelId: "test",
  supportedUrls: {},
  doGenerate: () => Promise.reject(new Error("not used by transformParams")),
  doStream: () => Promise.reject(new Error("not used by transformParams")),
};

function droppedToolProviderOptions() {
  return {
    toolCallMiddleware: {
      originalTools: [{ name: "op", inputSchema: '{"type":"object"}' }],
      droppedProviderTools: ["web_search"],
    },
  };
}

function expectWebSearchWarning(warnings: readonly object[]): void {
  expect(warnings).toEqual([
    expect.objectContaining({
      type: "unsupported",
      feature: "provider tool web_search",
    }),
  ]);
}

function generateWithDroppedTool(content: LanguageModelV4Content[]) {
  return wrapGenerate({
    protocol: dummyProtocol(),
    doGenerate: vi.fn().mockResolvedValue({
      content,
      warnings: [],
      finishReason: { unified: "stop", raw: "stop" },
    }),
    params: { providerOptions: droppedToolProviderOptions() },
  });
}

function providerResultStream(includeStart: boolean) {
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      if (includeStart) {
        controller.enqueue({ type: "stream-start", warnings: [] });
      }
      controller.enqueue({
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: zeroUsage,
      });
      controller.close();
    },
  });
}

function streamWithDroppedTool(includeStart: boolean) {
  return wrapStream({
    protocol: dummyProtocol(),
    doStream: vi.fn().mockResolvedValue({
      stream: providerResultStream(includeStart),
    }),
    doGenerate: vi.fn(),
    params: { providerOptions: droppedToolProviderOptions() },
  });
}

describe("provider tools are dropped with a spec warning", () => {
  it("transformParams records dropped provider tool names", async () => {
    const middleware = createToolMiddleware({
      protocol: hermesProtocol,
      toolSystemPromptTemplate: (tools) => `SYS:${tools}`,
    });
    const transformParams = requireTransformParams(middleware.transformParams);
    const params = {
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [functionTool, providerTool],
    } satisfies LanguageModelV4CallOptions;
    const output = await transformParams({ type: "generate", params, model });
    const middlewareOptions = output.providerOptions?.toolCallMiddleware;
    if (
      !(
        middlewareOptions &&
        Array.isArray(middlewareOptions.droppedProviderTools)
      )
    ) {
      throw new Error("missing dropped provider-tool metadata");
    }
    expect(middlewareOptions.droppedProviderTools).toEqual(["web_search"]);
  });

  for (const scenario of [
    {
      name: "wrapGenerate appends an unsupported warning for dropped tools",
      content: [{ type: "text", text: "hello" }],
    },
    {
      name: "wrapGenerate appends an unsupported warning even when content is empty",
      content: [],
    },
  ] satisfies readonly { name: string; content: LanguageModelV4Content[] }[]) {
    it(scenario.name, async () => {
      const result = await generateWithDroppedTool(scenario.content);
      expectWebSearchWarning(result.warnings);
    });
  }

  for (const scenario of [
    {
      name: "wrapStream appends the warning to stream-start",
      includeStart: true,
    },
    {
      name: "wrapStream emits dropped-tool warnings when the provider omits stream-start",
      includeStart: false,
    },
  ] satisfies readonly { name: string; includeStart: boolean }[]) {
    it(scenario.name, async () => {
      const result = await streamWithDroppedTool(scenario.includeStart);
      const parts = await convertReadableStreamToArray(result.stream);
      expect(parts[0]).toMatchObject({
        type: "stream-start",
        warnings: [
          expect.objectContaining({
            type: "unsupported",
            feature: "provider tool web_search",
          }),
        ],
      });
      if (!scenario.includeStart) {
        expect(parts[1]).toMatchObject({ type: "finish" });
      }
    });
  }
});
