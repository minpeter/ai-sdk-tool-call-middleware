import type { LanguageModelV3Content } from "@ai-sdk/provider";
import type { TCMCoreProtocol } from "../../protocols/protocol-interface";

export interface AssistantToolCallTextConversionOptions {
  onError?: (message: string, metadata?: Record<string, unknown>) => void;
}

export function assistantToolCallsToTextContent(options: {
  content: LanguageModelV3Content[];
  protocol: TCMCoreProtocol;
  conversionOptions?: AssistantToolCallTextConversionOptions;
}): LanguageModelV3Content[] {
  const newContent: LanguageModelV3Content[] = [];
  for (const item of options.content) {
    switch (item.type) {
      case "tool-call":
        newContent.push({
          type: "text",
          text: options.protocol.formatToolCall(item),
        });
        break;
      case "text":
      case "reasoning":
        newContent.push(item);
        break;
      default:
        options.conversionOptions?.onError?.(
          "tool-call-middleware: unknown assistant content; stringifying for provider compatibility",
          { content: item }
        );
        newContent.push({
          type: "text",
          text: JSON.stringify(item),
        });
    }
  }

  if (!newContent.every((entry) => entry.type === "text")) {
    return newContent;
  }

  return [
    {
      type: "text",
      text: newContent
        .map((entry) => (entry as { text: string }).text)
        .join("\n"),
    },
  ];
}
