import type {
  LanguageModelV3,
  LanguageModelV3FinishReason,
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import type { TCMCoreProtocol } from "./core/protocols/protocol-interface";
import { getDebugLevel, logParsedChunk, logRawChunk } from "./core/utils/debug";
import { generateToolCallId } from "./core/utils/id";
import { extractOnErrorOption } from "./core/utils/on-error";
import {
  emitMiddlewareEvent,
  extractOnEventOption,
  type OnEventFn,
} from "./core/utils/on-event";
import {
  decodeOriginalToolsFromProviderOptions,
  extractCoerceOptionsFromProviderOptions,
  getToolCallMiddlewareOptions,
  isToolChoiceActive,
  type ToolCallMiddlewareProviderOptions,
} from "./core/utils/provider-options";
import { coerceToolCallPart } from "./core/utils/tool-call-coercion";
import { resolveToolChoiceSelection } from "./core/utils/tool-choice";

export async function wrapStream({
  protocol,
  doStream,
  doGenerate,
  params,
}: {
  protocol: TCMCoreProtocol;
  doStream: () => ReturnType<LanguageModelV3["doStream"]>;
  doGenerate: () => ReturnType<LanguageModelV3["doGenerate"]>;
  params: {
    providerOptions?: ToolCallMiddlewareProviderOptions;
  };
}) {
  const onErrorOptions = extractOnErrorOption(params.providerOptions);
  const onEvent = extractOnEventOption(params.providerOptions)?.onEvent;
  const tools = decodeOriginalToolsFromProviderOptions(
    params.providerOptions,
    onErrorOptions
  );
  const coerceOptions = extractCoerceOptionsFromProviderOptions(
    params.providerOptions
  );
  emitMiddlewareEvent(onEvent, {
    type: "stream.start",
    metadata: {
      toolsCount: tools.length,
      toolChoiceActive: isToolChoiceActive(params),
    },
  });

  if (isToolChoiceActive(params)) {
    return toolChoiceStream({
      doGenerate,
      tools,
      options: {
        ...onErrorOptions,
        onEvent,
      },
    });
  }

  const { stream, ...rest } = await doStream();
  const debugLevel = getDebugLevel();
  const options = {
    ...onErrorOptions,
    ...getToolCallMiddlewareOptions(params.providerOptions),
  };

  const coreStream = stream
    .pipeThrough(
      new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>(
        {
          transform(part, controller) {
            if (debugLevel === "stream") {
              logRawChunk(part);
            }
            controller.enqueue(part);
          },
        }
      )
    )
    .pipeThrough(protocol.createStreamParser({ tools, options }));

  let seenToolCall = false;
  const v3Stream = coreStream.pipeThrough(
    new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
      transform(part, controller) {
        let normalizedPart =
          part.type === "tool-call"
            ? coerceToolCallPart(part, tools, coerceOptions)
            : part;

        if (normalizedPart.type === "tool-call") {
          seenToolCall = true;
          emitMiddlewareEvent(onEvent, {
            type: "stream.tool-call",
            metadata: { toolName: normalizedPart.toolName },
          });
        }

        if (
          normalizedPart.type === "finish" &&
          seenToolCall &&
          normalizedPart.finishReason.unified === "stop"
        ) {
          normalizedPart = {
            ...normalizedPart,
            finishReason: normalizeToolCallsFinishReason(
              normalizedPart.finishReason
            ),
          };
        }

        if (normalizedPart.type === "finish") {
          emitMiddlewareEvent(onEvent, {
            type: "stream.finish",
            metadata: {
              unifiedFinishReason: normalizedPart.finishReason.unified,
              rawFinishReason: normalizedPart.finishReason.raw,
            },
          });
        }

        if (debugLevel === "stream") {
          logParsedChunk(normalizedPart);
        }
        controller.enqueue(normalizedPart);
      },
    })
  );

  return {
    ...rest,
    stream: v3Stream,
  };
}

export async function toolChoiceStream({
  doGenerate,
  tools,
  options,
}: {
  doGenerate: () => ReturnType<LanguageModelV3["doGenerate"]>;
  tools?: LanguageModelV3FunctionTool[];
  options?: {
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
    onEvent?: OnEventFn;
  };
}) {
  const normalizedTools = Array.isArray(tools) ? tools : [];
  const result = await doGenerate();
  const first = result?.content?.[0];
  const firstText = first?.type === "text" ? first.text : undefined;
  const { toolName, input } = resolveToolChoiceSelection({
    text: firstText,
    tools: normalizedTools,
    onError: options?.onError,
    errorMessage: "Failed to parse toolChoice JSON from streamed model output",
  });
  emitMiddlewareEvent(options?.onEvent, {
    type: "stream.tool-choice",
    metadata: { toolName },
  });

  const stream = new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      controller.enqueue({
        type: "tool-call",
        toolCallId: generateToolCallId(),
        toolName,
        input,
      });
      controller.enqueue({
        type: "finish",
        usage: normalizeUsage(result?.usage),
        finishReason: normalizeToolCallsFinishReason(result?.finishReason),
      });
      emitMiddlewareEvent(options?.onEvent, {
        type: "stream.finish",
        metadata: {
          unifiedFinishReason: "tool-calls",
          rawFinishReason:
            typeof result?.finishReason === "string"
              ? result.finishReason
              : undefined,
        },
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

const ZERO_USAGE: LanguageModelV3Usage = {
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

function normalizeToolCallsFinishReason(
  finishReason: unknown
): LanguageModelV3FinishReason {
  let raw = "tool-calls";
  if (typeof finishReason === "string") {
    raw = finishReason;
  } else if (
    finishReason &&
    typeof finishReason === "object" &&
    "raw" in finishReason &&
    typeof (finishReason as { raw?: unknown }).raw === "string"
  ) {
    raw = (finishReason as { raw: string }).raw;
  } else if (
    finishReason &&
    typeof finishReason === "object" &&
    "unified" in finishReason &&
    typeof (finishReason as { unified?: unknown }).unified === "string"
  ) {
    raw = (finishReason as { unified: string }).unified;
  }

  return {
    unified: "tool-calls",
    raw,
  };
}

function normalizeUsage(usage: unknown): LanguageModelV3Usage {
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
    return usage as LanguageModelV3Usage;
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
