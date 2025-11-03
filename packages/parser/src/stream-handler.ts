import type {
  LanguageModelV3,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";

import type { ToolCallProtocol } from "./protocols/tool-call-protocol";
import {
  extractOnErrorOption,
  isToolChoiceActive,
  originalToolsSchema,
  type ToolCallMiddlewareProviderOptions,
} from "./utils";
import {
  getDebugLevel,
  logParsedChunk,
  logParsedSummary,
  logRawChunk,
} from "./utils/debug";

function extractToolCallSegments(
  protocol: ToolCallProtocol,
  fullRawText: string,
  tools: ReturnType<typeof originalToolsSchema.decode>
): string {
  const segments = protocol.extractToolCallSegments
    ? protocol.extractToolCallSegments({
        text: fullRawText,
        tools,
      })
    : [];
  return segments.join("\n\n");
}

function serializeToolCalls(
  parsedToolCalls: LanguageModelV3StreamPart[]
): string {
  const toolCallParts = parsedToolCalls.filter(
    (p): p is LanguageModelV3StreamPart & { type: "tool-call" } =>
      p.type === "tool-call"
  );
  return JSON.stringify(
    toolCallParts.map((tc) => ({
      toolName: tc.toolName,
      input: tc.input,
    }))
  );
}

function handleDebugSummary(
  parsedToolCalls: LanguageModelV3StreamPart[],
  origin: string,
  params: { providerOptions?: ToolCallMiddlewareProviderOptions }
): void {
  const dbg = params.providerOptions?.toolCallMiddleware?.debugSummary;
  if (dbg) {
    dbg.originalText = origin;
    try {
      dbg.toolCalls = serializeToolCalls(parsedToolCalls);
    } catch {
      // ignore
    }
  } else {
    logParsedSummary({
      toolCalls: parsedToolCalls,
      originalText: origin,
    });
  }
}

function createDebugSummaryTransform({
  protocol,
  fullRawText,
  tools,
  params,
}: {
  protocol: ToolCallProtocol;
  fullRawText: string;
  tools: ReturnType<typeof originalToolsSchema.decode>;
  params: { providerOptions?: ToolCallMiddlewareProviderOptions };
}): TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart> {
  return new TransformStream<
    LanguageModelV3StreamPart,
    LanguageModelV3StreamPart
  >({
    transform: (() => {
      const parsedToolCalls: LanguageModelV3StreamPart[] = [];
      return (
        part: LanguageModelV3StreamPart,
        controller: TransformStreamDefaultController<LanguageModelV3StreamPart>
      ) => {
        if (part.type === "tool-call") {
          parsedToolCalls.push(part);
        }
        if (part.type === "finish") {
          try {
            const origin = extractToolCallSegments(
              protocol,
              fullRawText,
              tools
            );
            handleDebugSummary(parsedToolCalls, origin, params);
          } catch {
            // ignore logging failures
          }
        }
        controller.enqueue(part);
      };
    })(),
  });
}

export async function wrapStream({
  protocol,
  doStream,
  doGenerate,
  params,
}: {
  protocol: ToolCallProtocol;
  doStream: () => ReturnType<LanguageModelV3["doStream"]>;
  doGenerate: () => ReturnType<LanguageModelV3["doGenerate"]>;
  params: {
    providerOptions?: ToolCallMiddlewareProviderOptions;
  };
}) {
  if (isToolChoiceActive(params)) {
    return toolChoiceStream({
      doGenerate,
      options: extractOnErrorOption(params.providerOptions),
    });
  }

  const { stream, ...rest } = await doStream();

  const debugLevel = getDebugLevel();

  const tools = originalToolsSchema.decode(
    params.providerOptions?.toolCallMiddleware?.originalTools
  );

  const options = {
    ...extractOnErrorOption(params.providerOptions),
    ...((params.providerOptions as { toolCallMiddleware?: unknown } | undefined)
      ?.toolCallMiddleware as Record<string, unknown>),
  };

  if (debugLevel === "off") {
    return {
      stream: stream.pipeThrough(
        protocol.createStreamParser({
          tools,
          options,
        })
      ),
      ...rest,
    };
  }

  if (debugLevel === "stream") {
    const withRawTap = stream.pipeThrough(
      new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>(
        {
          transform(part, controller) {
            logRawChunk(part);
            controller.enqueue(part);
          },
        }
      )
    );

    const parsed = withRawTap.pipeThrough(
      protocol.createStreamParser({
        tools,
        options,
      })
    );

    const withParsedTap = parsed.pipeThrough(
      new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>(
        {
          transform(part, controller) {
            logParsedChunk(part);
            controller.enqueue(part);
          },
        }
      )
    );

    return {
      stream: withParsedTap,
      ...rest,
    };
  }

  // debugLevel === "parse"
  let fullRawText = "";
  const withRawTap = stream.pipeThrough(
    new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
      transform(part, controller) {
        if (part.type === "text-delta") {
          const delta = (
            part as Extract<LanguageModelV3StreamPart, { type: "text-delta" }>
          ).delta as string | undefined;
          if (typeof delta === "string" && delta.length > 0) {
            fullRawText += delta;
          }
        }
        controller.enqueue(part);
      },
    })
  );

  const parsed = withRawTap.pipeThrough(
    protocol.createStreamParser({
      tools,
      options,
    })
  );

  const withSummary = parsed.pipeThrough(
    createDebugSummaryTransform({
      protocol,
      fullRawText,
      tools,
      params,
    })
  );

  return {
    stream: withSummary,
    ...rest,
  };
}

export async function toolChoiceStream({
  doGenerate,
  options,
}: {
  doGenerate: () => ReturnType<LanguageModelV3["doGenerate"]>;
  options?: {
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
  };
}) {
  const result = await doGenerate();

  // Assume result.content[0] contains tool-call information (JSON)
  let toolJson: { name?: string; arguments?: Record<string, unknown> } = {};
  if (
    result?.content &&
    result.content.length > 0 &&
    result.content[0]?.type === "text"
  ) {
    try {
      toolJson = JSON.parse(result.content[0].text);
    } catch (error) {
      options?.onError?.(
        "Failed to parse toolChoice JSON from streamed model output",
        {
          text: result.content[0].text,
          error: error instanceof Error ? error.message : String(error),
        }
      );
      toolJson = {};
    }
  }

  const toolCallChunk: LanguageModelV3StreamPart = {
    type: "tool-call",
    toolCallId: generateId(),
    toolName: toolJson.name || "unknown",
    input: JSON.stringify(toolJson.arguments || {}),
  };

  const finishChunk: LanguageModelV3StreamPart = {
    type: "finish",
    usage:
      result?.usage ||
      // TODO: If possible, try to return a certain amount of LLM usage.
      ({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      } as LanguageModelV3Usage),
    finishReason: "tool-calls" as LanguageModelV3FinishReason,
  };

  const stream = new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      controller.enqueue(toolCallChunk);
      controller.enqueue(finishChunk);
      controller.close();
    },
  });

  const debugLevel = getDebugLevel();
  const firstText =
    (result?.content?.[0] &&
      (result.content[0] as Extract<LanguageModelV3Content, { type: "text" }>)
        .type === "text" &&
      (result.content[0] as Extract<LanguageModelV3Content, { type: "text" }>)
        .text) ||
    "";
  const streamWithSummary =
    debugLevel === "parse"
      ? stream.pipeThrough(
          new TransformStream<
            LanguageModelV3StreamPart,
            LanguageModelV3StreamPart
          >({
            transform(part, controller) {
              if (part.type === "finish") {
                try {
                  logParsedSummary({
                    toolCalls: [toolCallChunk],
                    originalText:
                      typeof firstText === "string" ? firstText : "",
                  });
                } catch {
                  // ignore logging failures
                }
              }
              controller.enqueue(part);
            },
          })
        )
      : stream;

  return {
    request: result?.request || {},
    response: result?.response || {},
    stream: streamWithSummary,
  };
}
