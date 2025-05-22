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
      return {
        role: "assistant",
        content: message.content.map((content) => {
          if (content.type === "tool-call") {
            return {
              type: "text",
              text: `${toolCallTag}${JSON.stringify({
                arguments: content.args,
                name: content.toolName,
              })}${toolCallEndTag}`,
            };
          }

          return content;
        }),
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
