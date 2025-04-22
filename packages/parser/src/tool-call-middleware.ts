import type {
  LanguageModelV2Prompt,
  LanguageModelV2Middleware,
  LanguageModelV2StreamPart,
  LanguageModelV2ToolCall,
  LanguageModelV2Content,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";
import { getPotentialStartIndex } from "./utils/get-potential-start-index";
import * as RJSON from "./utils/relaxed-json";

export function createToolMiddleware({
  toolCallTag,
  toolCallEndTag,
  toolResponseTag,
  toolResponseEndTag,
  toolSystemPromptTemplate,
}: {
  toolCallTag: string;
  toolCallEndTag: string;
  toolResponseTag: string;
  toolResponseEndTag: string;
  toolSystemPromptTemplate: (tools: string) => string;
}): LanguageModelV2Middleware {
  return {
    middlewareVersion: "v2",
    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream();

      let isFirstToolCall = true;
      let isFirstText = true;
      let afterSwitch = false;
      let isToolCall = false;
      let buffer = "";

      let toolCallIndex = -1;
      let toolCallBuffer: string[] = [];

      const transformStream = new TransformStream<
        LanguageModelV2StreamPart,
        LanguageModelV2StreamPart
      >({
        transform(chunk, controller) {
          if (chunk.type === "finish") {
            if (toolCallBuffer.length > 0) {
              toolCallBuffer.forEach((toolCall) => {
                try {
                  const parsedToolCall = RJSON.parse(toolCall) as {
                    name: string;
                    arguments: string;
                  };

                  controller.enqueue({
                    type: "tool-call",
                    toolCallType: "function",
                    toolCallId: generateId(),
                    toolName: parsedToolCall.name,
                    args: JSON.stringify(parsedToolCall.arguments),
                  });
                } catch (e) {
                  console.error(`Error parsing tool call: ${toolCall}`, e);

                  controller.enqueue({
                    type: "text",
                    text: `Failed to parse tool call: ${e}`,
                  });
                }
              });
            }

            // stop token
            controller.enqueue(chunk);

            return;
          } else if (chunk.type !== "text") {
            controller.enqueue(chunk);
            return;
          }

          buffer += chunk.text;

          function publish(text: string) {
            if (text.length > 0) {
              const prefix =
                afterSwitch && (isToolCall ? !isFirstToolCall : !isFirstText)
                  ? "\n" // separator
                  : "";

              if (isToolCall) {
                if (!toolCallBuffer[toolCallIndex]) {
                  toolCallBuffer[toolCallIndex] = "";
                }

                toolCallBuffer[toolCallIndex] += text;
              } else {
                controller.enqueue({
                  type: "text",
                  text: prefix + text,
                });
              }

              afterSwitch = false;

              if (isToolCall) {
                isFirstToolCall = false;
              } else {
                isFirstText = false;
              }
            }
          }

          do {
            const nextTag = isToolCall ? toolCallEndTag : toolCallTag;
            const startIndex = getPotentialStartIndex(buffer, nextTag);

            // no opening or closing tag found, publish the buffer
            if (startIndex == null) {
              publish(buffer);
              buffer = "";
              break;
            }

            // publish text before the tag
            publish(buffer.slice(0, startIndex));

            const foundFullMatch = startIndex + nextTag.length <= buffer.length;

            if (foundFullMatch) {
              buffer = buffer.slice(startIndex + nextTag.length);
              toolCallIndex++;
              isToolCall = !isToolCall;
              afterSwitch = true;
            } else {
              buffer = buffer.slice(startIndex);
              break;
            }
          } while (true);
        },
      });

      return {
        stream: stream.pipeThrough(transformStream),
        ...rest,
      };
    },
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();

      // Handle case: content is empty
      if (result.content.length === 0) {
        return result;
      }

      const toolCallRegex = new RegExp(
        `${toolCallTag}(.*?)(?:${toolCallEndTag}|$)`,
        "gs"
      );

      // Process each content item using flatMap
      const newContent = result.content.flatMap(
        (contentItem): LanguageModelV2Content[] => {
          // Keep non-text items or text items without the tool call tag as they are.
          if (
            contentItem.type !== "text" ||
            !contentItem.text.includes(toolCallTag)
          ) {
            return [contentItem]; // Return as an array for flatMap
          }

          const text = contentItem.text;
          const processedElements: LanguageModelV2Content[] = [];
          let currentIndex = 0;
          let match;

          // --- Nested Tool Call Parsing Logic ---
          const parseAndCreateToolCall = (
            toolCallJson: string
          ): LanguageModelV2ToolCall | null => {
            try {
              const parsedToolCall = RJSON.parse(toolCallJson) as {
                name: string;
                arguments: unknown; // Use unknown for initial parsing flexibility
              };

              if (
                !parsedToolCall ||
                typeof parsedToolCall.name !== "string" ||
                typeof parsedToolCall.arguments === "undefined"
              ) {
                console.error(
                  "Failed to parse tool call: Invalid structure",
                  toolCallJson
                );
                return null;
              }

              return {
                type: "tool-call",
                toolCallType: "function",
                toolCallId: generateId(),
                toolName: parsedToolCall.name,
                // Ensure args is always a JSON string
                args:
                  typeof parsedToolCall.arguments === "string"
                    ? parsedToolCall.arguments
                    : JSON.stringify(parsedToolCall.arguments),
              };
            } catch (error) {
              console.error(
                "Failed to parse tool call JSON:",
                error,
                "JSON:",
                toolCallJson
              );
              return null; // Indicate failure
            }
          };
          // --- End of Nested Logic ---

          // Use regex.exec in a loop to find all matches and indices
          while ((match = toolCallRegex.exec(text)) !== null) {
            const startIndex = match.index;
            const endIndex = startIndex + match[0].length;
            const toolCallJson = match[1]; // Captured group 1: the JSON content

            // 1. Add text segment *before* the match
            if (startIndex > currentIndex) {
              const textSegment = text.substring(currentIndex, startIndex);
              // Add only if it contains non-whitespace characters
              if (textSegment.trim()) {
                processedElements.push({ type: "text", text: textSegment });
              }
            }

            // 2. Parse and add the tool call
            if (toolCallJson) {
              const toolCallObject = parseAndCreateToolCall(toolCallJson);
              if (toolCallObject) {
                processedElements.push(toolCallObject);
              } else {
                // Handle parsing failure: Option 1: Log and add original match as text
                console.warn(
                  `Could not process tool call, keeping original text: ${match[0]}`
                );
                processedElements.push({ type: "text", text: match[0] });
                // Option 2: Log and discard (do nothing here)
                // Option 3: Create a specific error content part if supported
              }
            }

            // 3. Update index for the next search
            currentIndex = endIndex;

            // Reset lastIndex if using exec with 'g' flag in a loop (though typically not needed if loop condition is `match !== null`)
            // toolCallRegex.lastIndex = currentIndex;
          }

          // 4. Add any remaining text *after* the last match
          if (currentIndex < text.length) {
            const remainingText = text.substring(currentIndex);
            // Add only if it contains non-whitespace characters
            if (remainingText.trim()) {
              processedElements.push({ type: "text", text: remainingText });
            }
          }

          // Return the array of processed parts, replacing the original text item
          return processedElements;
        }
      );

      // Return the result with the potentially modified content array
      return {
        ...result,
        content: newContent,
      };
    },

    transformParams: async ({ params }) => {
      const processedPrompt = params.prompt.map((message) => {
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
        JSON.stringify(Object.entries(params.tools || {}))
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

      return {
        ...params,
        prompt: toolSystemPrompt,

        // set the mode back to regular and remove the default tools.
        tools: [],
        toolChoice: undefined,
      };
    },
  };
}
