import type {
  LanguageModelV4,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
  LanguageModelV4ToolChoice,
} from "@ai-sdk/provider";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { wrapGenerate } from "../../generate-handler";
import { createToolMiddleware } from "../../tool-call-middleware";
import { stopFinishReason, zeroUsage } from "../test-helpers";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

describe("createToolMiddleware branches", () => {
  const generateResult = {
    content: [],
    finishReason: stopFinishReason,
    usage: zeroUsage,
    warnings: [],
  } satisfies LanguageModelV4GenerateResult;
  const streamResult = {
    stream: new ReadableStream(),
  } satisfies LanguageModelV4StreamResult;
  const fallbackDoStream = vi.fn(async () => streamResult);
  const model: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "test",
    modelId: "test",
    supportedUrls: {},
    doGenerate: async () => generateResult,
    doStream: async () => streamResult,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function runToolChoiceStream(
    toolChoice: LanguageModelV4ToolChoice,
    text: string
  ) {
    const middleware = createToolMiddleware({
      protocol: hermesProtocol,
      toolSystemPromptTemplate: () => "",
    });
    if (!middleware.wrapStream) {
      throw new Error("wrapStream is not defined");
    }
    return middleware.wrapStream({
      doStream: vi.fn().mockResolvedValue({ stream: new ReadableStream() }),
      doGenerate: vi.fn().mockResolvedValue({
        content: [{ type: "text", text }],
        finishReason: stopFinishReason,
        usage: zeroUsage,
        warnings: [],
      } satisfies LanguageModelV4GenerateResult),
      params: {
        prompt: [],
        providerOptions: { toolCallMiddleware: { toolChoice } },
      },
      model,
    });
  }
  it("wrapGenerate returns tool-call content when toolChoice active", async () => {
    const mw = createToolMiddleware({
      protocol: hermesProtocol,
      toolSystemPromptTemplate: () => "",
    });
    const doGenerate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"name":"n","arguments":{}}' }],
      finishReason: stopFinishReason,
      usage: zeroUsage,
      warnings: [],
    } satisfies LanguageModelV4GenerateResult);
    if (!mw.wrapGenerate) {
      throw new Error("wrapGenerate is not defined");
    }
    const result = await mw.wrapGenerate({
      doGenerate,
      doStream: fallbackDoStream,
      params: {
        prompt: [],
        providerOptions: {
          toolCallMiddleware: { toolChoice: { type: "required" } },
        },
      },
      model,
    });
    expect(result.content[0]).toMatchObject({
      type: "tool-call",
      toolName: "n",
      input: "{}",
    });
  });

  it("wrapStream handles toolChoice 'required' via stream handler", async () => {
    const result = await runToolChoiceStream(
      { type: "required" },
      '{"name":"n","arguments":{}}'
    );
    expect(result.stream).toBeDefined();
  });

  it("wrapGenerate toolChoice path coerces arguments with decoded tool schema", async () => {
    const mw = createToolMiddleware({
      protocol: hermesProtocol,
      toolSystemPromptTemplate: () => "",
    });

    if (!mw.wrapGenerate) {
      throw new Error("wrapGenerate is not defined");
    }
    const result = await mw.wrapGenerate({
      doGenerate: vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: '{"name":"calc","arguments":{"a":"10","b":"false"}}',
          },
        ],
        finishReason: stopFinishReason,
        usage: zeroUsage,
        warnings: [],
      } satisfies LanguageModelV4GenerateResult),
      doStream: fallbackDoStream,
      params: {
        prompt: [],
        providerOptions: {
          toolCallMiddleware: {
            toolChoice: { type: "required" },
            originalTools: [
              {
                name: "calc",
                inputSchema:
                  '{"type":"object","properties":{"a":{"type":"number"},"b":{"type":"boolean"}}}',
              },
            ],
          },
        },
      },
      model,
    });
    expect(result.content[0]).toMatchObject({
      type: "tool-call",
      toolName: "calc",
      input: '{"a":10,"b":false}',
    });
  });

  it("wrapStream handles toolChoice 'tool' via stream handler", async () => {
    const result = await runToolChoiceStream(
      { type: "tool", toolName: "x" },
      '{"name":"x","arguments":{}}'
    );
    expect(result.stream).toBeDefined();
  });

  it("wrapGenerate does not throw when originalTools contains malformed schema JSON", async () => {
    const onError = vi.fn();
    const doGenerate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: '<tool_call>{"name":"n","arguments":{"x":"1"}}</tool_call>',
        },
      ],
      finishReason: stopFinishReason,
      usage: zeroUsage,
      warnings: [],
    } satisfies LanguageModelV4GenerateResult);

    const result = await wrapGenerate({
      protocol: hermesProtocol(),
      doGenerate,
      params: {
        providerOptions: {
          toolCallMiddleware: {
            originalTools: [{ name: "n", inputSchema: "{" }],
            onError,
          },
        },
      },
    });

    expect(onError).toHaveBeenCalled();
    expect(result.content.some((part) => part.type === "tool-call")).toBe(true);
  });
});
