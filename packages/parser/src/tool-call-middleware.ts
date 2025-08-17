import type {
  LanguageModelV2Middleware,
  LanguageModelV2ToolCall,
  LanguageModelV2Content,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";

import {
  RJSON,
  convertToolPrompt,
  createDynamicIfThenElseSchema,
} from "./utils";
import { normalToolStream, toolChoiceStream } from "./stream-handler";

function isToolChoiceActive(params: { providerOptions?: unknown }): boolean {
  const toolChoice = (params?.providerOptions as any)?.toolCallMiddleware
    ?.toolChoice;
  return (
    typeof params.providerOptions === "object" &&
    params.providerOptions !== null &&
    typeof (params.providerOptions as any).toolCallMiddleware === "object" &&
    toolChoice &&
    typeof toolChoice === "object" &&
    (toolChoice.type === "tool" || toolChoice.type === "required")
  );
}

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
    wrapStream: async ({ doStream, doGenerate, params }) => {
      if (isToolChoiceActive(params)) {
        // Handle tool choice type "tool" or "required" in streaming
        return toolChoiceStream({
          doGenerate,
        });
      } else {
        return normalToolStream({
          doStream,
          toolCallTag,
          toolCallEndTag,
        });
      }
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate();

      // Handle case: content is empty
      if (result.content.length === 0) {
        return result;
      }

      // Handle case: set tool choice type "tool" and tool name
      if (isToolChoiceActive(params)) {
        const toolJson: { name?: string; arguments?: Record<string, unknown> } =
          result.content[0].type === "text"
            ? JSON.parse(result.content[0].text)
            : {};

        return {
          ...result,
          content: [
            {
              type: "tool-call",
              toolCallType: "function",
              toolCallId: generateId(),
              toolName: toolJson.name || "unknown",
              input: JSON.stringify(toolJson.arguments || {}),
            },
          ],
        };
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
                toolCallId: generateId(),
                toolName: parsedToolCall.name,
                // Ensure args is always a JSON string
                input:
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
      const toolSystemPrompt = convertToolPrompt({
        paramsPrompt: params.prompt,
        paramsTools: params.tools,
        toolSystemPromptTemplate,
        toolCallTag,
        toolCallEndTag,
        toolResponseTag,
        toolResponseEndTag,
      });

      const baseReturnParams = {
        ...params,
        prompt: toolSystemPrompt,
        // Reset tools and toolChoice to default after prompt transformation
        tools: [],
        toolChoice: undefined,
      };

      if (params.toolChoice?.type === "none") {
        throw new Error(
          "The 'none' toolChoice type is not supported by this middleware. Please use 'auto', 'required', or specify a tool name."
        );
      }

      // Handle specific tool choice scenario
      if (params.toolChoice?.type === "tool") {
        const selectedToolName = params.toolChoice.toolName;
        const selectedTool = params.tools?.find(tool =>
          tool.type === "function"
            ? tool.name === selectedToolName
            : tool.id === selectedToolName
        );

        if (!selectedTool) {
          throw new Error(
            `Tool with name '${selectedToolName}' not found in params.tools.`
          );
        }

        if (selectedTool.type === "provider-defined") {
          throw new Error(
            "Provider-defined tools are not supported by this middleware. Please use custom tools."
          );
        }

        return {
          ...baseReturnParams,

          responseFormat: {
            type: "json",
            schema: {
              type: "object",
              properties: {
                name: {
                  const: selectedTool.name,
                },
                arguments: selectedTool.inputSchema,
              },
              required: ["name", "arguments"],
            },
            name: selectedTool.name,
            description:
              selectedTool.type === "function" &&
              typeof selectedTool.description === "string"
                ? selectedTool.description
                : undefined,
          },
          providerOptions: {
            toolCallMiddleware: {
              toolChoice: params.toolChoice,
            },
          },
        };
      }

      if (params.toolChoice?.type === "required") {
        if (!params.tools || params.tools.length === 0) {
          throw new Error(
            "Tool choice type 'required' is set, but no tools are provided in params.tools."
          );
        }

        return {
          ...baseReturnParams,
          responseFormat: {
            type: "json",
            schema: createDynamicIfThenElseSchema(params.tools),
          },
          providerOptions: {
            toolCallMiddleware: {
              toolChoice: { type: "required" },
            },
          },
        };
      }

      return baseReturnParams;
    },
  };
}
