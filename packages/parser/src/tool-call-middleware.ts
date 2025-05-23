import type {
  LanguageModelV2Prompt,
  LanguageModelV2Middleware,
  LanguageModelV2StreamPart,
  LanguageModelV2ToolCall,
  LanguageModelV2Content,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";
import { getPotentialStartIndex, RJSON } from "./utils";
import { convertToolPrompt } from "./utils/conv-tool-prompt";

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
      let justSwitchedMode = false;
      let parsingToolCall = false;
      let textChunkBuffer = "";

      let toolCallIndex = -1;
      let bufferedToolCallParts: string[] = [];

      const transformStream = new TransformStream<
        LanguageModelV2StreamPart,
        LanguageModelV2StreamPart
      >({
        transform(chunk, controller) {
          if (chunk.type === "finish") {
            if (bufferedToolCallParts.length > 0) {
              bufferedToolCallParts.forEach((toolCall) => {
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
                } catch (e: any) {
                  // Log the original text that failed parsing
                  console.error(
                    `Error parsing tool call JSON: "${toolCall}"`,
                    e
                  );

                  controller.enqueue({
                    type: "text",
                    text: JSON.stringify({
                      errorType: "tool-call-parsing-error",
                      source: "tool-call-parsing",
                      message: e.message || "Failed to parse tool call JSON",
                      details: toolCall, // The string that failed to parse
                    }),
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

          textChunkBuffer += chunk.text;

          function publish(text: string) {
            if (text.length > 0) {
              const prefix =
                justSwitchedMode && (parsingToolCall ? !isFirstToolCall : !isFirstText)
                  ? "\n" // separator
                  : "";

              if (parsingToolCall) {
                if (!bufferedToolCallParts[toolCallIndex]) {
                  bufferedToolCallParts[toolCallIndex] = "";
                }

                bufferedToolCallParts[toolCallIndex] += text;
              } else {
                controller.enqueue({
                  type: "text",
                  text: prefix + text,
                });
              }

              justSwitchedMode = false;

              if (parsingToolCall) {
                isFirstToolCall = false;
              } else {
                isFirstText = false;
              }
            }
          }

          do {
            const nextTag = parsingToolCall ? toolCallEndTag : toolCallTag;
            const startIndex = getPotentialStartIndex(textChunkBuffer, nextTag);

            // no opening or closing tag found, publish the buffer
            if (startIndex == null) {
              publish(textChunkBuffer);
              textChunkBuffer = "";
              break;
            }

            // publish text before the tag
            publish(textChunkBuffer.slice(0, startIndex));

            const foundFullMatch = startIndex + nextTag.length <= textChunkBuffer.length;

            if (foundFullMatch) {
              textChunkBuffer = textChunkBuffer.slice(startIndex + nextTag.length);
              toolCallIndex++;
              parsingToolCall = !parsingToolCall;
              justSwitchedMode = true;
            } else {
              textChunkBuffer = textChunkBuffer.slice(startIndex);
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
          ): LanguageModelV2ToolCall | LanguageModelV2Content => {
            // Changed return type
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
                // Return structured error as a text part
                return {
                  type: "text",
                  text: JSON.stringify({
                    errorType: "tool-call-parsing-error",
                    originalText: toolCallJson,
                    error: {
                      message: "Invalid tool call structure",
                      data: parsedToolCall, // Include what was parsed, if anything
                    },
                  }),
                };
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
              // Return structured error as a text part
              return {
                type: "text",
                text: JSON.stringify({
                  errorType: "tool-call-parsing-error",
                  originalText: toolCallJson,
                  error: {
                    message: (error as Error).message || "Failed to parse tool call JSON",
                    // Avoid serializing the raw error object if it's complex or circular
                    details: error.toString(), 
                  },
                }),
              };
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
              const parsedResult = parseAndCreateToolCall(toolCallJson);
              // Check if the result is a tool call or a text (error) part
              if (parsedResult.type === "tool-call") {
                processedElements.push(parsedResult as LanguageModelV2ToolCall);
              } else {
                // It's a text part representing an error
                console.warn(
                  `Could not fully process tool call. Original text wrapped in error JSON: ${
                    (parsedResult as { text: string }).text
                  }`
                );
                processedElements.push(parsedResult); // Add the text error content part
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
      const toolSystemPrompt = convertToolPrompt({
        paramsPrompt: params.prompt,
        paramsTools: params.tools,
        toolSystemPromptTemplate,
        toolCallTag,
        toolCallEndTag,
        toolResponseTag,
        toolResponseEndTag,
      });

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
