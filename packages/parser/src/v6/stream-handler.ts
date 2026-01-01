import type {
  LanguageModelV3,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";

import type { ToolCallProtocol } from "../core/protocols/tool-call-protocol";
import type { CoreStreamPart } from "../core/types";
import {
  getDebugLevel,
  logParsedChunk,
  logRawChunk,
} from "../core/utils/debug";
import { extractOnErrorOption } from "../core/utils/on-error";
import {
  isToolChoiceActive,
  originalToolsSchema,
  type ToolCallMiddlewareProviderOptions,
} from "../core/utils/provider-options";

function mapCorePartToV3(part: CoreStreamPart): LanguageModelV3StreamPart {
  switch (part.type) {
    case "text-delta":
      return {
        type: "text-delta",
        id: part.id || generateId(),
        delta: part.textDelta,
      } as LanguageModelV3StreamPart;
    case "tool-call":
      return {
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      } as LanguageModelV3StreamPart;
    case "tool-call-delta":
      return {
        type: "tool-call-delta",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        argsTextDelta: part.argsTextDelta,
      } as unknown as LanguageModelV3StreamPart;
    case "finish":
      return {
        type: "finish",
        finishReason: part.finishReason,
        usage: part.usage,
      } as unknown as LanguageModelV3StreamPart;
    case "error":
      return {
        type: "error",
        error: part.error,
      } as LanguageModelV3StreamPart;
    default:
      return part as LanguageModelV3StreamPart;
  }
}

function mapV3PartToCore(part: LanguageModelV3StreamPart): CoreStreamPart {
  const p = part as Record<string, unknown>;
  switch (p.type) {
    case "text-delta":
      return {
        type: "text-delta",
        id: p.id as string | undefined,
        textDelta: ((p.delta || p.textDelta) as string) || "",
      };
    case "tool-call":
      return {
        type: "tool-call",
        toolCallId: p.toolCallId as string,
        toolName: p.toolName as string,
        input: p.input as string,
      };
    case "finish": {
      const finishReason = p.finishReason as
        | { unified?: string }
        | string
        | undefined;
      return {
        type: "finish",
        finishReason:
          (typeof finishReason === "object"
            ? finishReason?.unified
            : finishReason) || "stop",
        usage: p.usage as
          | { promptTokens: number; completionTokens: number }
          | undefined,
      };
    }
    default:
      return p as CoreStreamPart;
  }
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
    ...((params.providerOptions as Record<string, unknown>)
      ?.toolCallMiddleware || {}),
  };

  const coreStream = stream
    .pipeThrough(
      new TransformStream<LanguageModelV3StreamPart, CoreStreamPart>({
        transform(part, controller) {
          if (debugLevel === "stream") {
            logRawChunk(part);
          }
          controller.enqueue(mapV3PartToCore(part));
        },
      })
    )
    .pipeThrough(protocol.createStreamParser({ tools, options }));

  const v3Stream = coreStream.pipeThrough(
    new TransformStream<CoreStreamPart, LanguageModelV3StreamPart>({
      transform(part, controller) {
        const v3Part = mapCorePartToV3(part);
        if (debugLevel === "stream") {
          logParsedChunk(v3Part);
        }
        controller.enqueue(v3Part);
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
