import type {
  LanguageModelV2StreamPart,
  LanguageModelV2,
  LanguageModelV2Usage,
  LanguageModelV2FinishReason,
  LanguageModelV2FunctionTool,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";
import { ToolCallProtocol } from "./protocols/tool-call-protocol";
import {
  isToolChoiceActive,
  getFunctionTools,
  extractOnErrorOption,
} from "./utils";

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
  return {
    stream: stream.pipeThrough(
      protocol.createStreamParser({
        tools: getFunctionTools(params),
        options: {
          ...extractOnErrorOption(params.providerOptions),
          ...(params.providerOptions as any)?.toolCallMiddleware,
        },
      })
    ),
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

  return {
    request: result?.request || {},
    response: result?.response || {},
    stream,
  };
}
