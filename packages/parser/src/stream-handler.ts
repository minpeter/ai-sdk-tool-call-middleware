import type {
  LanguageModelV3,
  LanguageModelV3StreamPart,
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
        if (debugLevel === "stream") {
          logParsedChunk(part);
        }
        controller.enqueue(part);
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
  options,
}: {
  doGenerate: () => ReturnType<LanguageModelV3["doGenerate"]>;
  options?: {
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
  };
}) {
  const result = await doGenerate();
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

  const stream = new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      controller.enqueue({
        type: "tool-call",
        toolCallId: generateId(),
        toolName: toolJson.name || "unknown",
        input: JSON.stringify(toolJson.arguments || {}),
      });
      controller.enqueue({
        type: "finish",
        usage: result?.usage || {
          inputTokens: 0,
          outputTokens: 0,
        },
        finishReason: "tool-calls",
      } as unknown as LanguageModelV3StreamPart);
      controller.close();
    },
  });

  return {
    request: result?.request || {},
    response: result?.response || {},
    stream,
  };
}
