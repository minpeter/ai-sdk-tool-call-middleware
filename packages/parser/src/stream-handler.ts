import type {
  LanguageModelV2,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2FunctionTool,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";

import { ToolCallProtocol } from "./protocols/tool-call-protocol";
import {
  extractOnErrorOption,
  getFunctionTools,
  isToolChoiceActive,
} from "./utils";
import {
  getDebugLevel,
  logParsedChunk,
  logParsedSummary,
  logRawChunk,
} from "./utils/debug";

type WrapStreamParams = Parameters<typeof isToolChoiceActive>[0] & {
  tools?: Array<LanguageModelV2FunctionTool | { type: string }>;
  providerOptions?: unknown;
};

export async function wrapStream({
  protocol,
  doStream,
  doGenerate,
  params,
}: {
  protocol: ToolCallProtocol;
  doStream: () => ReturnType<LanguageModelV2["doStream"]>;
  doGenerate: () => ReturnType<LanguageModelV2["doGenerate"]>;
  params: WrapStreamParams;
}) {
  if (isToolChoiceActive(params)) {
    return toolChoiceStream({
      doGenerate,
      options: extractOnErrorOption(params.providerOptions),
    });
  }

  const { stream, ...rest } = await doStream();

  const debugLevel = getDebugLevel();
  let fullRawText = "";
  const withRawTap = stream.pipeThrough(
    new TransformStream<LanguageModelV2StreamPart, LanguageModelV2StreamPart>({
      transform(part, controller) {
        if (debugLevel === "stream") {
          logRawChunk(part);
        }
        if (debugLevel === "parse" && part.type === "text-delta") {
          const delta = (
            part as Extract<LanguageModelV2StreamPart, { type: "text-delta" }>
          ).delta as string | undefined;
          if (typeof delta === "string" && delta.length > 0)
            fullRawText += delta;
        }
        controller.enqueue(part);
      },
    })
  );

  const parsed = withRawTap.pipeThrough(
    protocol.createStreamParser({
      tools: getFunctionTools(params),
      options: {
        ...extractOnErrorOption(params.providerOptions),
        ...((
          params.providerOptions as { toolCallMiddleware?: unknown } | undefined
        )?.toolCallMiddleware as Record<string, unknown>),
      },
    })
  );

  const withParsedTap = parsed.pipeThrough(
    new TransformStream<LanguageModelV2StreamPart, LanguageModelV2StreamPart>({
      start() {
        /* noop */
      },
      transform(part, controller) {
        if (debugLevel === "stream") {
          logParsedChunk(part);
        }
        controller.enqueue(part);
      },
    })
  );

  // For parse mode, emit summary after finish
  const withSummary = withParsedTap.pipeThrough(
    new TransformStream<LanguageModelV2StreamPart, LanguageModelV2StreamPart>({
      start() {
        /* noop */
      },
      transform: (() => {
        const parsedToolCalls: LanguageModelV2StreamPart[] = [];
        return (
          part: LanguageModelV2StreamPart,
          controller: TransformStreamDefaultController<LanguageModelV2StreamPart>
        ) => {
          if (debugLevel === "parse" && part.type === "tool-call") {
            parsedToolCalls.push(part);
          }
          if (debugLevel === "parse" && part.type === "finish") {
            try {
              const segments = protocol.extractToolCallSegments
                ? protocol.extractToolCallSegments({
                    text: fullRawText,
                    tools: getFunctionTools(params),
                  })
                : [];
              const origin = segments.join("\n\n");
              logParsedSummary({
                toolCalls: parsedToolCalls,
                originalText: origin,
              });
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
