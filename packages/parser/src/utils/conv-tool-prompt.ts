import {
  LanguageModelV2FunctionTool,
  LanguageModelV2Prompt,
  LanguageModelV2ProviderDefinedTool,
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
  const processedPrompt = paramsPrompt.map((message) => {
    if (message.role === "assistant") {
      // Convert and merge tool-call and text type content while preserving order
      const mergedContents: typeof message.content = [];
      for (const content of message.content) {
        if (content.type === "tool-call") {
          mergedContents.push({
            type: "text",
            text: `${toolCallTag}${JSON.stringify({
              arguments: content.args,
              name: content.toolName,
            })}${toolCallEndTag}`,
          });
        } else {
          mergedContents.push(content);
        }
      }
      // 연속된 text 블록을 하나로 합침
      const finalContents: typeof message.content = [];
      for (const item of mergedContents) {
        if (
          finalContents.length > 0 &&
          item.type === "text" &&
          finalContents[finalContents.length - 1].type === "text"
        ) {
          // 마지막 text와 합침
          finalContents[finalContents.length - 1] = {
            type: "text",
            text:
              finalContents[finalContents.length - 1].text +
              "\n" +
              item.text,
          };
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
                (content) =>
                  `${toolResponseTag}${JSON.stringify({
                    toolName: content.toolName,
                    result: content.result,
                  })}${toolResponseEndTag}`
              )
              .join("\n"),
          },
        ],
      };
    }

    return message;
  }) as LanguageModelV2Prompt;

  const HermesPrompt = toolSystemPromptTemplate(
    JSON.stringify(Object.entries(paramsTools || {}))
  );

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
