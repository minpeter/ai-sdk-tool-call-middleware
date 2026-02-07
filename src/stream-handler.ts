import type {
  LanguageModelV3,
  LanguageModelV3FinishReason,
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";
import type { TCMCoreProtocol } from "./core/protocols/protocol-interface";
import { getDebugLevel, logParsedChunk, logRawChunk } from "./core/utils/debug";
import { extractOnErrorOption } from "./core/utils/on-error";
import {
  isToolChoiceActive,
  originalToolsSchema,
  type ToolCallMiddlewareProviderOptions,
} from "./core/utils/provider-options";
import { coerceToolCallPart } from "./core/utils/tool-call-coercion";
import { parseToolChoicePayload } from "./core/utils/tool-choice";

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
  const tools = originalToolsSchema.decode(
    params.providerOptions?.toolCallMiddleware?.originalTools,
    onErrorOptions
  );

  if (isToolChoiceActive(params)) {
    return toolChoiceStream({
      doGenerate,
      tools,
      options: onErrorOptions,
    });
  }

  const { stream, ...rest } = await doStream();
  const debugLevel = getDebugLevel();
  const options = {
    ...onErrorOptions,
    ...((params.providerOptions as Record<string, unknown>)
      ?.toolCallMiddleware || {}),
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

  const v3Stream = coreStream.pipeThrough(
    new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
      transform(part, controller) {
        const normalizedPart =
          part.type === "tool-call" ? coerceToolCallPart(part, tools) : part;
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
  tools: LanguageModelV3FunctionTool[];
  options?: {
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
  };
}) {
  const result = await doGenerate();
  let toolName = "unknown";
  let input = "{}";
  if (
    result?.content &&
    result.content.length > 0 &&
    result.content[0]?.type === "text"
  ) {
    const parsed = parseToolChoicePayload({
      text: result.content[0].text,
      tools,
      onError: options?.onError,
      errorMessage:
        "Failed to parse toolChoice JSON from streamed model output",
    });
    toolName = parsed.toolName;
    input = parsed.input;
  }

  const stream = new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      controller.enqueue({
        type: "tool-call",
        toolCallId: generateId(),
        toolName,
        input,
      });
      controller.enqueue({
        type: "finish",
        usage: normalizeUsage(result?.usage),
        finishReason: normalizeToolCallsFinishReason(result?.finishReason),
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
  const raw =
    finishReason &&
    typeof finishReason === "object" &&
    "raw" in finishReason &&
    typeof (finishReason as { raw?: unknown }).raw === "string"
      ? (finishReason as { raw: string }).raw
      : "tool-calls";

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

  return ZERO_USAGE;
}
