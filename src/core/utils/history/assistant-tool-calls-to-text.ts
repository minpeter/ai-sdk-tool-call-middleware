import type {
  LanguageModelV4Content,
  LanguageModelV4ToolCall,
} from "@ai-sdk/provider";

interface AssistantToolCallTextConversionOptions {
  onError?: (message: string, metadata?: Record<string, unknown>) => void;
}

interface ToolCallFormatter {
  formatToolCall: (toolCall: LanguageModelV4ToolCall) => string;
}

export function assistantToolCallsToTextContent(options: {
  content: LanguageModelV4Content[];
  protocol: ToolCallFormatter;
  conversionOptions?: AssistantToolCallTextConversionOptions;
}): LanguageModelV4Content[] {
  const newContent: LanguageModelV4Content[] = [];
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
