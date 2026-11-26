import type {
  LanguageModelV4,
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolCall,
  LanguageModelV4Usage,
  SharedV4Warning,
} from "@ai-sdk/provider";
import type { TCMProtocol } from "./core/protocols/protocol-interface";
import { coerceToolCallPart } from "./core/utils/coercion/tool-call-coercion";
import {
  getDebugLevel,
  logParsedChunk,
  logRawChunk,
} from "./core/utils/diagnostics/debug";
import {
  recordForcedToolChoiceDebugSummary,
  recordParsedDebugSummary,
} from "./core/utils/diagnostics/debug-summary";
import { extractOnErrorOption } from "./core/utils/diagnostics/on-error";
import { generateToolCallId } from "./core/utils/primitives/id";
import { createStreamJsonRecoveryTransform } from "./core/utils/recovery/stream-json-recovery";
import {
  normalizeForcedToolChoiceFinishReason,
  normalizeToolCallsFinishReason,
  shouldRewriteFinishReasonToToolCalls,
} from "./core/utils/response/finish-reason";
import {
  createCitationCaptureTransform,
  createCitationRestoreTransform,
} from "./core/utils/response/text-citations";
import {
  createDroppedProviderToolWarnings,
  decodeOriginalToolsForMiddleware,
  getToolCallMiddlewareOptions,
  getToolChoiceExpectedToolName,
  isToolChoiceActive,
  isToolChoiceNone,
  type ToolCallMiddlewareDebugSummary,
  type ToolCallMiddlewareProviderOptions,
} from "./core/utils/transport/provider-options";
import {
  findToolChoiceResultText,
  resolveToolChoiceSelection,
} from "./core/utils/transport/tool-choice";

export async function wrapStream({
  protocol,
  doStream,
  doGenerate,
  params,
}: {
  protocol: TCMProtocol;
  doStream: () => ReturnType<LanguageModelV4["doStream"]>;
  doGenerate: () => ReturnType<LanguageModelV4["doGenerate"]>;
  params: {
    providerOptions?: ToolCallMiddlewareProviderOptions;
  };
}) {
  if (isToolChoiceNone(params)) {
    // toolChoice 'none': no tool prompt was injected and no tool calls are
    // expected, so pass the model stream through untouched.
    return doStream();
  }

  const onErrorOptions = extractOnErrorOption(params.providerOptions);
  const tools = decodeOriginalToolsForMiddleware(
    params.providerOptions,
    onErrorOptions
  );

  const extraWarnings = createDroppedProviderToolWarnings(
    params.providerOptions
  );

  if (isToolChoiceActive(params)) {
    return toolChoiceStream({
      doGenerate,
      tools,
      expectedToolName: getToolChoiceExpectedToolName(params.providerOptions),
      options: onErrorOptions,
      extraWarnings,
      debugSummary: params.providerOptions?.toolCallMiddleware?.debugSummary,
    });
  }

  const { stream, ...rest } = await doStream();
  const debugLevel = getDebugLevel();
  const collectSummary = Boolean(
    params.providerOptions?.toolCallMiddleware?.debugSummary ||
      debugLevel === "parse"
  );
  const rawTextChunks: string[] = [];
  const options = {
    ...onErrorOptions,
    ...getToolCallMiddlewareOptions(params.providerOptions),
  };

  const tappedStream =
    debugLevel === "stream" || collectSummary
      ? stream.pipeThrough(
          new TransformStream<
            LanguageModelV4StreamPart,
            LanguageModelV4StreamPart
          >({
            transform(part, controller) {
              if (debugLevel === "stream") {
                logRawChunk(part);
              }
              if (collectSummary && part.type === "text-delta") {
                rawTextChunks.push(part.delta);
              }
              controller.enqueue(part);
            },
          })
        )
      : stream;

  // Citations ride on the provider's `text-end`, which the protocol parser
  // drops, so they are captured before parsing and restored after it.
  const coreStream = tappedStream
    .pipeThrough(createCitationCaptureTransform())
    .pipeThrough(protocol.createStreamParser({ tools, options }))
    .pipeThrough(
      createStreamJsonRecoveryTransform({
        allowsRecovery: protocol.allowsFallbackRecovery,
        tools,
      })
    )
    .pipeThrough(createCitationRestoreTransform());

  let seenToolCall = false;
  let emittedExtraWarnings = extraWarnings.length === 0;
  let recordedSummary = false;
  const collectedToolCalls: LanguageModelV4ToolCall[] = [];

  const finalizeSummary = () => {
    if (!collectSummary || recordedSummary) {
      return;
    }
    recordedSummary = true;
    recordParsedDebugSummary({
      allText: rawTextChunks.join(""),
      debugSummary: params.providerOptions?.toolCallMiddleware?.debugSummary,
      extractToolCallSegments: protocol.extractToolCallSegments,
      toolCalls: collectedToolCalls,
      tools,
    });
  };

  const normalizePart = (
    part: LanguageModelV4StreamPart
  ): LanguageModelV4StreamPart => {
    // Provider-executed tool calls pass through byte-identical and do not
    // trigger the tool-calls finish rewrite: the provider already ran them.
    if (part.type === "tool-call") {
      const normalized = part.providerExecuted
        ? part
        : coerceToolCallPart(part, tools);
      if (collectSummary) {
        collectedToolCalls.push(normalized);
      }
      if (!normalized.providerExecuted) {
        seenToolCall = true;
      }
      return normalized;
    }

    if (part.type !== "finish") {
      return part;
    }

    finalizeSummary();
    if (
      seenToolCall &&
      shouldRewriteFinishReasonToToolCalls(part.finishReason)
    ) {
      return {
        ...part,
        finishReason: normalizeToolCallsFinishReason(part.finishReason),
      };
    }
    return part;
  };

  const outputStream = coreStream.pipeThrough(
    new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
      transform(part, controller) {
        if (part.type === "stream-start" && extraWarnings.length > 0) {
          emittedExtraWarnings = true;
          controller.enqueue({
            ...part,
            warnings: [...(part.warnings ?? []), ...extraWarnings],
          });
          return;
        }

        if (!emittedExtraWarnings) {
          emittedExtraWarnings = true;
          controller.enqueue({
            type: "stream-start",
            warnings: extraWarnings,
          });
        }

        const normalizedPart = normalizePart(part);
        if (debugLevel === "stream") {
          logParsedChunk(normalizedPart);
        }
        controller.enqueue(normalizedPart);
      },
      flush() {
        finalizeSummary();
      },
    })
  );

  return {
    ...rest,
    stream: outputStream,
  };
}

function enqueueReasoningContent(
  controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>,
  content: LanguageModelV4Content[] | undefined
) {
  for (const part of content ?? []) {
    if (part.type !== "reasoning") {
      continue;
    }
    const id = generateToolCallId();
    controller.enqueue({
      type: "reasoning-start",
      id,
      ...(part.providerMetadata
        ? { providerMetadata: part.providerMetadata }
        : {}),
    });
    if (part.text.length > 0) {
      controller.enqueue({ type: "reasoning-delta", id, delta: part.text });
    }
    controller.enqueue({ type: "reasoning-end", id });
  }
}

export async function toolChoiceStream({
  doGenerate,
  tools,
  expectedToolName,
  options,
  extraWarnings = [],
  debugSummary,
}: {
  doGenerate: () => ReturnType<LanguageModelV4["doGenerate"]>;
  expectedToolName?: string;
  tools?: LanguageModelV4FunctionTool[];
  options?: {
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
  };
  extraWarnings?: SharedV4Warning[];
  debugSummary?: ToolCallMiddlewareDebugSummary;
}) {
  const normalizedTools = Array.isArray(tools) ? tools : [];
  const result = await doGenerate();
  const { toolName, input, originText } = resolveToolChoiceSelection({
    text: findToolChoiceResultText(result),
    tools: normalizedTools,
    onError: options?.onError,
    errorMessage: "Failed to parse toolChoice JSON from streamed model output",
    expectedToolName,
  });

  const toolCallId = generateToolCallId();
  const toolCall: LanguageModelV4ToolCall = {
    type: "tool-call",
    toolCallId,
    toolName,
    input,
  };
  recordForcedToolChoiceDebugSummary({
    debugSummary,
    originText,
    toolCall,
  });

  const stream = new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      controller.enqueue({
        type: "stream-start",
        warnings: [...(result?.warnings ?? []), ...extraWarnings],
      });
      const { id, timestamp, modelId } = result?.response ?? {};
      if (
        id !== undefined ||
        timestamp !== undefined ||
        modelId !== undefined
      ) {
        controller.enqueue({
          type: "response-metadata",
          ...(id === undefined ? {} : { id }),
          ...(timestamp === undefined ? {} : { timestamp }),
          ...(modelId === undefined ? {} : { modelId }),
        });
      }
      enqueueReasoningContent(controller, result?.content);
      controller.enqueue({
        type: "tool-input-start",
        id: toolCallId,
        toolName,
      });
      if (input.length > 0) {
        controller.enqueue({
          type: "tool-input-delta",
          id: toolCallId,
          delta: input,
        });
      }
      controller.enqueue({
        type: "tool-input-end",
        id: toolCallId,
      });
      controller.enqueue(toolCall);
      controller.enqueue({
        type: "finish",
        usage: normalizeUsage(result?.usage),
        finishReason: normalizeForcedToolChoiceFinishReason(
          result?.finishReason
        ),
        ...(result?.providerMetadata
          ? { providerMetadata: result.providerMetadata }
          : {}),
      });
      controller.close();
    },
  });

  return {
    request: result?.request || {},
    response: result?.response || {},
    stream,
  };
}

const ZERO_USAGE: LanguageModelV4Usage = {
  inputTokens: {
    total: 0,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 0,
    text: undefined,
    reasoning: undefined,
  },
};

function normalizeUsage(usage: unknown): LanguageModelV4Usage {
  if (!usage || typeof usage !== "object") {
    return ZERO_USAGE;
  }

  const usageRecord = usage as Record<string, unknown>;
  const input = usageRecord.inputTokens;
  const output = usageRecord.outputTokens;
  if (
    input &&
    typeof input === "object" &&
    output &&
    typeof output === "object"
  ) {
    return usage as LanguageModelV4Usage;
  }

  if (typeof input === "number" && typeof output === "number") {
    return {
      inputTokens: {
        total: input,
        noCache: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: {
        total: output,
        text: undefined,
        reasoning: undefined,
      },
    };
  }

  return ZERO_USAGE;
}
