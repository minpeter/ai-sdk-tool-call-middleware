import {
  LanguageModelV2FunctionTool,
  LanguageModelV2ProviderDefinedTool,
  LanguageModelV2Prompt,
} from "@ai-sdk/provider";

export function convertToolPrompt({
  paramsPrompt,
  paramsTools,
  toolSystemPromptTemplate,
  toolCallTag,
  toolCallEndTag,
  toolResponseTag,
  toolResponseEndTag,
}: {
  paramsPrompt: LanguageModelV2Prompt;
  paramsTools?: Array<
    LanguageModelV2FunctionTool | LanguageModelV2ProviderDefinedTool
  >;
  toolSystemPromptTemplate: (tools: string) => string;
  toolCallTag: string;
  toolCallEndTag: string;
  toolResponseTag: string;
  toolResponseEndTag: string;
}): LanguageModelV2Prompt {
  const processedPrompt = paramsPrompt.map(message => {
    if (message.role === "assistant") {
      // Convert and merge tool-call and text type content while preserving order
      const mergedContents: typeof message.content = [];
      for (const content of message.content) {
        if (content.type === "tool-call") {
          mergedContents.push({
            type: "text",
            text: `${toolCallTag}${JSON.stringify({
              arguments: content.input,
              name: content.toolName,
            })}${toolCallEndTag}`,
          });
        } else {
          mergedContents.push(content);
        }
      }
      // Merge consecutive text blocks into one
      const finalContents: typeof message.content = [];
      for (const item of mergedContents) {
        if (
          finalContents.length > 0 &&
          item.type === "text" &&
          finalContents[finalContents.length - 1].type === "text"
        ) {
          // Merge with the last text block
          const last = finalContents[finalContents.length - 1];
          if (last.type === "text" && item.type === "text") {
            finalContents[finalContents.length - 1] = {
              type: "text",
              text: last.text + "\n" + item.text,
            };
          }
        } else {
          finalContents.push(item);
        }
      }
      return {
        role: "assistant",
        content: finalContents,
      };
    } else if (message.role === "tool") {
      return {
        role: "user",
        content: [
          {
            type: "text",
            text: message.content
              .map(
                content =>
                  `${toolResponseTag}${JSON.stringify({
                    toolName: content.toolName,
                    // TODO: If the tool result part contains content, modify to respect and include it.
                    result: content.output,
                  })}${toolResponseEndTag}`
              )
              .join("\n"),
          },
        ],
      };
    }

    return message;
  }) as LanguageModelV2Prompt;

  // Serialize tools as an array of function descriptors instead of Object.entries (which introduces numeric keys)
  const toolsForPrompt = (paramsTools || [])
    .filter(tool => tool.type === "function")
    .map(tool => ({
      name: tool.name,
      description:
        tool.type === "function" && typeof tool.description === "string"
          ? tool.description
          : undefined,
      parameters: tool.inputSchema,
    }));

  const HermesPrompt = toolSystemPromptTemplate(JSON.stringify(toolsForPrompt));

  const toolSystemPrompt: LanguageModelV2Prompt =
    processedPrompt[0].role === "system"
      ? [
          {
            role: "system",
            content: HermesPrompt + "\n\n" + processedPrompt[0].content,
          },
          ...processedPrompt.slice(1),
        ]
      : [
          {
            role: "system",
            content: HermesPrompt,
          },
          ...processedPrompt,
        ];

  return toolSystemPrompt;
}
