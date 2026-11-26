import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import { describe, expect, it, vi } from "vitest";
import { glm5Protocol } from "../../core/protocols/glm5/protocol";
import { hermesProtocol } from "../../core/protocols/hermes/protocol";
import { kExaone236BProtocol } from "../../core/protocols/k-exaone/k-exaone-236b-protocol";
import type {
  ParserOptions,
  TCMProtocol,
} from "../../core/protocols/protocol-interface";
import { extractYamlToolCallSpans } from "../../core/utils/recovery/generated-text-yaml-markup";
import {
  encodeOriginalTools,
  getDroppedProviderTools,
  getMiddlewareInternalState,
  isToolChoiceActive,
  isToolChoiceNone,
  type ToolCallMiddlewareDebugSummary,
} from "../../core/utils/transport/provider-options";
import { wrapGenerate } from "../../generate-handler";
import { wrapStream } from "../../stream-handler";
import { createToolMiddleware } from "../../tool-call-middleware";
import { transformParams } from "../../transform-handler";

const weatherTools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "get_weather",
    description: "Get weather",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
];

const ZERO_USAGE = {
  inputTokens: {
    total: 1,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 1,
    text: undefined,
    reasoning: undefined,
  },
};

async function drainStream(
  stream: ReadableStream<LanguageModelV4StreamPart>
): Promise<LanguageModelV4StreamPart[]> {
  const parts: LanguageModelV4StreamPart[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    parts.push(value);
  }
  return parts;
}

describe("v6 architecture & isolation contracts", () => {
  it("replaces stale _internal transport state on reused providerOptions across auto and none requests", async () => {
    const middleware = createToolMiddleware({
      protocol: hermesProtocol,
      promptStrategy: {
        mode: "text",
        template: (tools) => `Tools: ${tools.map((t) => t.name).join(",")}`,
      },
    });

    const forcedParams = transformParams({
      protocol: hermesProtocol,
      promptStrategy: {
        mode: "text",
        template: (tools) => `Tools: ${tools.map((t) => t.name).join(",")}`,
      },
      params: {
        prompt: [{ role: "user", content: [{ type: "text", text: "first" }] }],
        tools: [
          ...weatherTools,
          {
            type: "provider-defined",
            id: "ghost.tool",
            name: "ghost_tool",
          } as { type: string },
        ],
        toolChoice: { type: "tool", toolName: "get_weather" },
        providerOptions: {
          toolCallMiddleware: { emitRawToolCallTextOnError: true },
        },
      },
    });

    expect(isToolChoiceActive(forcedParams)).toBe(true);
    expect(getDroppedProviderTools(forcedParams.providerOptions)).toEqual([
      "ghost_tool",
    ]);

    // Reuse providerOptions from the forced request on a subsequent auto request
    const autoParams = transformParams({
      protocol: hermesProtocol,
      promptStrategy: {
        mode: "text",
        template: (tools) => `Tools: ${tools.map((t) => t.name).join(",")}`,
      },
      params: {
        prompt: [{ role: "user", content: [{ type: "text", text: "second" }] }],
        tools: weatherTools,
        toolChoice: { type: "auto" },
        providerOptions: forcedParams.providerOptions,
      },
    });

    expect(isToolChoiceActive(autoParams)).toBe(false);
    expect(isToolChoiceNone(autoParams)).toBe(false);
    expect(getDroppedProviderTools(autoParams.providerOptions)).toEqual([]);
    expect(
      getMiddlewareInternalState(autoParams.providerOptions).toolChoice
    ).toBeUndefined();
    expect(
      (
        autoParams.providerOptions?.toolCallMiddleware as Record<
          string,
          unknown
        >
      )?.emitRawToolCallTextOnError
    ).toBe(true);

    // End-to-end stream through wrapLanguageModel with reused providerOptions must call doStream, NOT doGenerate
    const doGenerateSpy = vi.fn().mockRejectedValue(new Error("unexpected"));
    const doStreamSpy = vi.fn().mockResolvedValue({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: "plain" });
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: ZERO_USAGE,
          });
          controller.close();
        },
      }),
    });
    const baseModel: LanguageModelV4 = {
      specificationVersion: "v4",
      provider: "test",
      modelId: "test",
      supportedUrls: {},
      doGenerate: doGenerateSpy,
      doStream: doStreamSpy,
    };
    const wrapped = wrapLanguageModel({ model: baseModel, middleware });
    const streamResult = await wrapped.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "second" }] }],
      tools: weatherTools,
      toolChoice: { type: "auto" },
      providerOptions: forcedParams.providerOptions,
    });
    const streamParts = await drainStream(streamResult.stream);
    expect(doGenerateSpy).not.toHaveBeenCalled();
    expect(doStreamSpy).toHaveBeenCalledTimes(1);
    expect(streamParts.some((p) => p.type === "text-delta")).toBe(true);

    // Reuse providerOptions on a `none` request clears originalTools and droppedProviderTools
    const noneParams = transformParams({
      protocol: hermesProtocol,
      promptStrategy: {
        mode: "text",
        template: (tools) => `Tools: ${tools.map((t) => t.name).join(",")}`,
      },
      params: {
        prompt: [{ role: "user", content: [{ type: "text", text: "third" }] }],
        tools: weatherTools,
        toolChoice: { type: "none" },
        providerOptions: forcedParams.providerOptions,
      },
    });
    expect(isToolChoiceNone(noneParams)).toBe(true);
    expect(getMiddlewareInternalState(noneParams.providerOptions)).toEqual({
      toolChoice: { type: "none" },
    });
  });

  it("strips toolCallMiddleware from provider-facing params and restricts protocol ParserOptions", async () => {
    const seenGenerateOptions: Array<ParserOptions | undefined> = [];
    const seenStreamOptions: Array<ParserOptions | undefined> = [];
    const baseHermes = hermesProtocol();
    const inspectingProtocol: TCMProtocol = {
      ...baseHermes,
      parseGeneratedText(args) {
        seenGenerateOptions.push(args.options);
        return baseHermes.parseGeneratedText(args);
      },
      createStreamParser(args) {
        seenStreamOptions.push(args.options);
        return baseHermes.createStreamParser(args);
      },
    };

    const seenModelGenerateParams: LanguageModelV4CallOptions[] = [];
    const seenModelStreamParams: LanguageModelV4CallOptions[] = [];
    const baseModel: LanguageModelV4 = {
      specificationVersion: "v4",
      provider: "test",
      modelId: "test",
      supportedUrls: {},
      doGenerate: (callParams) => {
        seenModelGenerateParams.push(callParams);
        return Promise.resolve({
          content: [{ type: "text", text: "hello" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: ZERO_USAGE,
          warnings: [],
        });
      },
      doStream: (callParams) => {
        seenModelStreamParams.push(callParams);
        return Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              controller.enqueue({ type: "text-start", id: "t1" });
              controller.enqueue({
                type: "text-delta",
                id: "t1",
                delta: "hello",
              });
              controller.enqueue({ type: "text-end", id: "t1" });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: ZERO_USAGE,
              });
              controller.close();
            },
          }),
        });
      },
    };

    const middleware = createToolMiddleware({
      protocol: inspectingProtocol,
      promptStrategy: {
        mode: "text",
        template: (tools) => `Tools: ${tools.map((t) => t.name).join(",")}`,
      },
    });
    const wrapped = wrapLanguageModel({ model: baseModel, middleware });
    const onError = vi.fn();
    const debugSummary: ToolCallMiddlewareDebugSummary = {};

    await wrapped.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: weatherTools,
      providerOptions: {
        openai: { user: "u1" },
        toolCallMiddleware: {
          onError,
          emitRawToolCallTextOnError: true,
          debugSummary,
        },
      } as unknown as LanguageModelV4CallOptions["providerOptions"],
    });

    const { stream } = await wrapped.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: weatherTools,
      providerOptions: {
        openai: { user: "u2" },
        toolCallMiddleware: {
          onError,
          emitRawToolCallTextOnError: false,
          debugSummary,
        },
      } as unknown as LanguageModelV4CallOptions["providerOptions"],
    });
    await drainStream(stream);

    // Underlying model never receives toolCallMiddleware (including _internal / debugSummary), while preserving other namespaces
    expect(seenModelGenerateParams[0]?.providerOptions).toEqual({
      openai: { user: "u1" },
    });
    expect(seenModelStreamParams[0]?.providerOptions).toEqual({
      openai: { user: "u2" },
    });

    // Protocol parsers receive ONLY ParserOptions keys
    expect(Object.keys(seenGenerateOptions[0] ?? {}).sort()).toEqual([
      "emitRawToolCallTextOnError",
      "onError",
    ]);
    expect(Object.keys(seenStreamOptions[0] ?? {}).sort()).toEqual([
      "emitRawToolCallTextOnError",
      "onError",
    ]);
  });

  it("preserves custom doGenerate and doStream thunks when no toolCallMiddleware options need stripping", async () => {
    const middleware = createToolMiddleware({
      protocol: hermesProtocol,
      promptStrategy: {
        mode: "text",
        template: (tools) => `Tools: ${tools.map((t) => t.name).join(",")}`,
      },
    });
    const modelDoGenerate = vi.fn(() => Promise.reject(new Error("bypassed")));
    const modelDoStream = vi.fn(() => Promise.reject(new Error("bypassed")));
    const customDoGenerate = vi.fn(() =>
      Promise.resolve({
        content: [{ type: "text" as const, text: "ok" }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: ZERO_USAGE,
        warnings: [],
      })
    );
    const customDoStream = vi.fn(() =>
      Promise.resolve({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.close();
          },
        }),
      })
    );
    const model: LanguageModelV4 = {
      specificationVersion: "v4",
      provider: "test",
      modelId: "test",
      supportedUrls: {},
      doGenerate: modelDoGenerate,
      doStream: modelDoStream,
    };

    const params: LanguageModelV4CallOptions = {
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      providerOptions: { openai: { user: "u1" } },
    };

    await middleware.wrapGenerate?.({
      doGenerate: customDoGenerate,
      doStream: customDoStream,
      params,
      model,
    });
    const streamRes = await middleware.wrapStream?.({
      doGenerate: customDoGenerate,
      doStream: customDoStream,
      params,
      model,
    });
    if (streamRes) {
      await drainStream(streamRes.stream);
    }

    expect(customDoGenerate).toHaveBeenCalledTimes(1);
    expect(customDoStream).toHaveBeenCalledTimes(1);
    expect(modelDoGenerate).not.toHaveBeenCalled();
    expect(modelDoStream).not.toHaveBeenCalled();
  });

  it("never bypasses custom parseGeneratedText when spreading glm5Protocol", async () => {
    const customParse = vi.fn(
      ({ text }: { text: string }): LanguageModelV4Content[] => [
        { type: "text", text: `custom:${text}` },
      ]
    );
    const customProtocol: TCMProtocol = {
      ...glm5Protocol(),
      parseGeneratedText: customParse,
    };

    const result = await wrapGenerate({
      protocol: customProtocol,
      doGenerate: () =>
        Promise.resolve({
          content: [{ type: "text", text: "hello world" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: ZERO_USAGE,
          warnings: [],
        }),
      params: {
        providerOptions: {
          toolCallMiddleware: {
            _internal: { originalTools: encodeOriginalTools(weatherTools) },
          },
        },
      },
    });

    expect(customParse).toHaveBeenCalledTimes(1);
    expect(result.content).toEqual([
      { type: "text", text: "custom:hello world" },
    ]);
  });

  it("preserves `this` receiver for class-based protocol hooks and defers extractToolCallSegments when diagnostics are off", async () => {
    class ClassProtocol implements TCMProtocol {
      readonly allowRecovery: boolean;
      readonly plainText: boolean;
      readonly tag = "class-segment";
      extractorGetterReads = 0;

      constructor(options: { allowRecovery: boolean; plainText: boolean }) {
        this.allowRecovery = options.allowRecovery;
        this.plainText = options.plainText;
      }

      allowsFallbackRecovery(_text: string): boolean {
        return this.allowRecovery;
      }

      isDefinitelyPlainGeneratedText(_text: string): boolean {
        return this.plainText;
      }

      get extractToolCallSegments() {
        this.extractorGetterReads += 1;
        return function (this: ClassProtocol, { text }: { text: string }) {
          return [`${this.tag}:${text}`];
        };
      }

      formatToolCall = hermesProtocol().formatToolCall;
      formatTools = hermesProtocol().formatTools;

      parseGeneratedText({ text }: { text: string }): LanguageModelV4Content[] {
        return [{ type: "text", text }];
      }

      createStreamParser() {
        return new TransformStream<
          LanguageModelV4StreamPart,
          LanguageModelV4StreamPart
        >();
      }
    }

    const jsonText = '{"name":"get_weather","arguments":{"city":"Seoul"}}';

    // 1. Diagnostics off + allowsFallbackRecovery returns false using `this`
    const noRecovery = new ClassProtocol({
      allowRecovery: false,
      plainText: false,
    });
    const genRes = await wrapGenerate({
      protocol: noRecovery,
      doGenerate: () =>
        Promise.resolve({
          content: [{ type: "text", text: jsonText }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: ZERO_USAGE,
          warnings: [],
        }),
      params: {
        providerOptions: {
          toolCallMiddleware: {
            _internal: { originalTools: encodeOriginalTools(weatherTools) },
          },
        },
      },
    });
    expect(genRes.content).toEqual([{ type: "text", text: jsonText }]);
    expect(noRecovery.extractorGetterReads).toBe(0);

    const streamRes = await wrapStream({
      protocol: noRecovery,
      doGenerate: () => Promise.reject(new Error("not used")),
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              controller.enqueue({ type: "text-start", id: "t1" });
              controller.enqueue({
                type: "text-delta",
                id: "t1",
                delta: jsonText,
              });
              controller.enqueue({ type: "text-end", id: "t1" });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: ZERO_USAGE,
              });
              controller.close();
            },
          }),
        }),
      params: {
        providerOptions: {
          toolCallMiddleware: {
            _internal: { originalTools: encodeOriginalTools(weatherTools) },
          },
        },
      },
    });
    const streamParts = await drainStream(streamRes.stream);
    expect(streamParts.some((p) => p.type === "tool-call")).toBe(false);
    expect(noRecovery.extractorGetterReads).toBe(0);

    // 2. Diagnostics on + isDefinitelyPlainGeneratedText skips fallback using `this`
    const plainOnly = new ClassProtocol({
      allowRecovery: true,
      plainText: true,
    });
    const debugSummary: ToolCallMiddlewareDebugSummary = {};
    const plainGenRes = await wrapGenerate({
      protocol: plainOnly,
      doGenerate: () =>
        Promise.resolve({
          content: [{ type: "text", text: jsonText }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: ZERO_USAGE,
          warnings: [],
        }),
      params: {
        providerOptions: {
          toolCallMiddleware: {
            debugSummary,
            _internal: { originalTools: encodeOriginalTools(weatherTools) },
          },
        },
      },
    });
    expect(plainGenRes.content).toEqual([{ type: "text", text: jsonText }]);
    expect(plainOnly.extractorGetterReads).toBe(1);
    expect(debugSummary.originalText).toBe(`class-segment:${jsonText}`);
  });

  it("isolates hermesProtocol wrapToolCallResolver helpers per instance and composes resolveToolCall", () => {
    const seenHelpers: unknown[] = [];
    const customBase = vi.fn((_json, _tools) => ({
      ok: true as const,
      toolName: "get_weather",
      input: '{"city":"Composed"}',
    }));

    const composed = hermesProtocol({
      resolveToolCall: customBase,
      wrapToolCallResolver: (helpers) => {
        seenHelpers.push(helpers);
        expect(Object.isFrozen(helpers)).toBe(true);
        expect(() => {
          (helpers as { resolveDefault: unknown }).resolveDefault = () => ({
            ok: false,
            error: new Error("mutated"),
          });
        }).toThrow(TypeError);
        return (toolCallJson, tools) =>
          helpers.resolveDefault(toolCallJson, tools);
      },
    });

    const other = hermesProtocol({
      wrapToolCallResolver: (helpers) => {
        seenHelpers.push(helpers);
        return helpers.resolveDefault;
      },
    });

    expect(seenHelpers[0]).not.toBe(seenHelpers[1]);

    const composedParts = composed.parseGeneratedText({
      text: '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call>',
      tools: weatherTools,
    });
    expect(customBase).toHaveBeenCalledTimes(1);
    expect(composedParts).toEqual([
      expect.objectContaining({
        type: "tool-call",
        toolName: "get_weather",
        input: '{"city":"Composed"}',
      }),
    ]);

    const otherParts = other.parseGeneratedText({
      text: '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call>',
      tools: weatherTools,
    });
    expect(otherParts).toEqual([
      expect.objectContaining({
        type: "tool-call",
        toolName: "get_weather",
        input: '{"city":"Seoul"}',
      }),
    ]);

    const kExaoneParts = kExaone236BProtocol().parseGeneratedText({
      text: '<tool_call>{"name":"get_weather","parameters":{"city":"Seoul"}}</tool_call>',
      tools: weatherTools,
    });
    expect(kExaoneParts).toEqual([
      expect.objectContaining({
        type: "tool-call",
        toolName: "get_weather",
        input: '{"city":"Seoul"}',
      }),
    ]);
  });

  it("handles promptStrategy messages mode with empty build and suppressForForcedChoice", () => {
    const build = vi.fn(() => [
      { role: "system" as const, content: "catalog" },
    ]);
    const prompt = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "hi" }],
      },
    ];

    const suppressed = transformParams({
      protocol: hermesProtocol,
      promptStrategy: {
        mode: "messages",
        build,
        suppressForForcedChoice: true,
      },
      params: {
        prompt,
        tools: weatherTools,
        toolChoice: { type: "required" },
      },
    });
    expect(build).not.toHaveBeenCalled();
    expect(suppressed.prompt).toEqual(prompt);

    const emptyBuilt = transformParams({
      protocol: hermesProtocol,
      promptStrategy: {
        mode: "messages",
        build: () => [],
      },
      params: {
        prompt,
        tools: weatherTools,
      },
    });
    expect(emptyBuilt.prompt).toEqual(prompt);
  });

  it("drops prototype-sensitive YAML candidates consistently for namespaced tool names", () => {
    const namespacedTools: LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "functions:get_weather",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      },
    ];
    const spans = extractYamlToolCallSpans(
      "<tool_call>\ncity: Seoul\nconstructor:\n  polluted: true\n</functions:get_weather>",
      namespacedTools
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      dropReason: "prototype-sensitive-tool-candidate",
    });
  });
});
