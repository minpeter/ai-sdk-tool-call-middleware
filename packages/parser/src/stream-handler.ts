import type {
  LanguageModelV2StreamPart,
  LanguageModelV2,
  LanguageModelV2Usage,
  LanguageModelV2FinishReason,
  LanguageModelV2FunctionTool,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";
import { ToolCallProtocol } from "./protocols/tool-call-protocol";

export async function normalToolStream({
  doStream,
  protocol,
  tools,
}: {
  doStream: () => ReturnType<LanguageModelV2["doStream"]>;
  protocol: ToolCallProtocol;
  tools: LanguageModelV2FunctionTool[];
}) {
  const { stream, ...rest } = await doStream();

  return {
    stream: stream.pipeThrough(protocol.createStreamParser({ tools })),
    ...rest,
  };
}

export async function toolChoiceStream({
  doGenerate,
}: {
  doGenerate: () => ReturnType<LanguageModelV2["doGenerate"]>;
}) {
  const result = await doGenerate();

  // Assume result.content[0] contains tool-call information (JSON)
  const toolJson: { name?: string; arguments?: Record<string, unknown> } =
    result?.content &&
    result.content.length > 0 &&
    result.content[0]?.type === "text"
      ? JSON.parse(result.content[0].text)
      : {};

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
