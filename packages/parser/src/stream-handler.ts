import type {
  LanguageModelV2,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";

import { ToolCallProtocol } from "./protocols/tool-call-protocol";
import {
  extractOnErrorOption,
  isToolChoiceActive,
  originalToolsSchema,
  ToolCallMiddlewareProviderOptions,
} from "./utils";
import {
  getDebugLevel,
  logParsedChunk,
  logParsedSummary,
  logRawChunk,
} from "./utils/debug";

export async function wrapStream({
  protocol,
  doStream,
  doGenerate,
  params,
}: {
  protocol: ToolCallProtocol;
  doStream: () => ReturnType<LanguageModelV2["doStream"]>;
  doGenerate: () => ReturnType<LanguageModelV2["doGenerate"]>;
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
      new TransformStream<LanguageModelV2StreamPart, LanguageModelV2StreamPart>(
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
      new TransformStream<LanguageModelV2StreamPart, LanguageModelV2StreamPart>(
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
    new TransformStream<LanguageModelV2StreamPart, LanguageModelV2StreamPart>({
      transform(part, controller) {
        if (part.type === "text-delta") {
          const delta = (
            part as Extract<LanguageModelV2StreamPart, { type: "text-delta" }>
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
    new TransformStream<LanguageModelV2StreamPart, LanguageModelV2StreamPart>({
      transform: (() => {
        const parsedToolCalls: LanguageModelV2StreamPart[] = [];
        return (
          part: LanguageModelV2StreamPart,
          controller: TransformStreamDefaultController<LanguageModelV2StreamPart>
        ) => {
          if (part.type === "tool-call") {
            parsedToolCalls.push(part);
          }
          if (part.type === "finish") {
            try {
              const segments = protocol.extractToolCallSegments
                ? protocol.extractToolCallSegments({
                    text: fullRawText,
                    tools,
                  })
                : [];
              const origin = segments.join("\n\n");
              // Prefer JSON-safe debug container over console logs
              const dbg =
                params.providerOptions?.toolCallMiddleware?.debugSummary;
              if (dbg) {
                dbg.originalText = origin;
                try {
                  const toolCallParts = parsedToolCalls.filter(
                    (
                      p
                    ): p is LanguageModelV2StreamPart & { type: "tool-call" } =>
                      p.type === "tool-call"
                  );
                  dbg.toolCalls = JSON.stringify(
                    toolCallParts.map(tc => ({
                      toolName: tc.toolName,
                      input: tc.input,
                    }))
                  );
                } catch {
                  // ignore
                }
              } else {
                logParsedSummary({
                  toolCalls: parsedToolCalls,
                  originalText: origin,
                });
              }
            } catch {
              // ignore logging failures
            }
          }
          controller.enqueue(part);
        };
      })(),
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
  doGenerate: () => ReturnType<LanguageModelV2["doGenerate"]>;
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

  const toolCallChunk: LanguageModelV2StreamPart = {
    type: "tool-call",
    toolCallId: generateId(),
    toolName: toolJson.name || "unknown",
    input: JSON.stringify(toolJson.arguments || {}),
  };

  const finishChunk: LanguageModelV2StreamPart = {
    type: "finish",
    usage:
      result?.usage ||
      // TODO: If possible, try to return a certain amount of LLM usage.
      ({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      } as LanguageModelV2Usage),
    finishReason: "tool-calls" as LanguageModelV2FinishReason,
  };

  const stream = new ReadableStream<LanguageModelV2StreamPart>({
    start(controller) {
      controller.enqueue(toolCallChunk);
      controller.enqueue(finishChunk);
      controller.close();
    },
  });

  const debugLevel = getDebugLevel();
  const firstText =
    (result?.content &&
      result.content[0] &&
      (result.content[0] as Extract<LanguageModelV2Content, { type: "text" }>)
        .type === "text" &&
      (result.content[0] as Extract<LanguageModelV2Content, { type: "text" }>)
        .text) ||
    "";
  const streamWithSummary =
    debugLevel === "parse"
      ? stream.pipeThrough(
          new TransformStream<
            LanguageModelV2StreamPart,
            LanguageModelV2StreamPart
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
