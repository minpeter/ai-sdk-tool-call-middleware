import type {
  LanguageModelV4,
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
  SharedV4Warning,
} from "@ai-sdk/provider";
import type { TCMCoreProtocol } from "./core/protocols/protocol-interface";
import { getDebugLevel, logParsedChunk, logRawChunk } from "./core/utils/debug";
import {
  normalizeForcedToolChoiceFinishReason,
  normalizeToolCallsFinishReason,
  shouldRewriteFinishReasonToToolCalls,
} from "./core/utils/finish-reason";
import { generateToolCallId } from "./core/utils/id";
import { extractOnErrorOption } from "./core/utils/on-error";
import {
  decodeOriginalToolsFromProviderOptions,
  getDroppedProviderTools,
  getToolCallMiddlewareOptions,
  isToolChoiceActive,
  isToolChoiceNone,
  type ToolCallMiddlewareProviderOptions,
} from "./core/utils/provider-options";
import { createStreamJsonRecoveryTransform } from "./core/utils/stream-json-recovery";
import { coerceToolCallPart } from "./core/utils/tool-call-coercion";
import {
  findFirstTextContent,
  resolveToolChoiceSelection,
} from "./core/utils/tool-choice";

/**
 * Prompt-based tool calling can only express function tools; provider tools
 * are dropped in transformParams and surfaced here as spec warnings.
 */
function droppedProviderToolWarnings(
  providerOptions: unknown
): SharedV4Warning[] {
  return getDroppedProviderTools(providerOptions).map(
    (name): SharedV4Warning => ({
      type: "unsupported",
      feature: `provider tool ${name}`,
      details:
        "Prompt-based tool-call middleware only supports function tools; the provider tool was removed from the request.",
    })
  );
}

export async function wrapStream({
  protocol,
  doStream,
  doGenerate,
  params,
}: {
  protocol: TCMCoreProtocol;
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
  const tools = decodeOriginalToolsFromProviderOptions(
    params.providerOptions,
    onErrorOptions
  );

  const extraWarnings = droppedProviderToolWarnings(params.providerOptions);

  if (isToolChoiceActive(params)) {
    return toolChoiceStream({
      doGenerate,
      tools,
      options: onErrorOptions,
      extraWarnings,
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
      new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>(
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
    .pipeThrough(protocol.createStreamParser({ tools, options }))
    .pipeThrough(createStreamJsonRecoveryTransform({ tools }));

  let seenToolCall = false;
  const outputStream = coreStream.pipeThrough(
    new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
      transform(part, controller) {
        if (part.type === "stream-start" && extraWarnings.length > 0) {
          controller.enqueue({
            ...part,
            warnings: [...(part.warnings ?? []), ...extraWarnings],
          });
          return;
        }

        // Provider-executed tool calls pass through byte-identical and do not
        // trigger the tool-calls finish rewrite: the provider already ran them.
        let normalizedPart =
          part.type === "tool-call" && !part.providerExecuted
            ? coerceToolCallPart(part, tools)
            : part;

        if (
          normalizedPart.type === "tool-call" &&
          !normalizedPart.providerExecuted
        ) {
          seenToolCall = true;
        }

        if (
          normalizedPart.type === "finish" &&
          seenToolCall &&
          shouldRewriteFinishReasonToToolCalls(normalizedPart.finishReason)
        ) {
          normalizedPart = {
            ...normalizedPart,
            finishReason: normalizeToolCallsFinishReason(
              normalizedPart.finishReason
            ),
          };
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
  options,
  extraWarnings = [],
}: {
  doGenerate: () => ReturnType<LanguageModelV4["doGenerate"]>;
  tools?: LanguageModelV4FunctionTool[];
  options?: {
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
  };
  extraWarnings?: SharedV4Warning[];
}) {
  const normalizedTools = Array.isArray(tools) ? tools : [];
  const result = await doGenerate();
  const { toolName, input } = resolveToolChoiceSelection({
    text: findFirstTextContent(result?.content),
    tools: normalizedTools,
    onError: options?.onError,
    errorMessage: "Failed to parse toolChoice JSON from streamed model output",
  });

  const toolCallId = generateToolCallId();
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
      controller.enqueue({
        type: "tool-call",
        toolCallId,
        toolName,
        input,
      });
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
