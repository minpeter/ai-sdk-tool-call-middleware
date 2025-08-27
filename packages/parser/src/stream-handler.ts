import type {
  LanguageModelV2StreamPart,
  LanguageModelV2,
  LanguageModelV2Usage,
  LanguageModelV2FinishReason,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";

export async function toolChoiceStream({
  doGenerate,
}: {
  doGenerate: () => ReturnType<LanguageModelV2["doGenerate"]>;
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
    } catch {
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
