import { JSONSchema7 } from "json-schema";

import type {
  LanguageModelV2Middleware,
  LanguageModelV2StreamPart,
  LanguageModelV2ToolCall,
  LanguageModelV2Content,
  LanguageModelV2FunctionTool,
  LanguageModelV2ProviderDefinedTool,
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
    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate();

      // Handle case: content is empty
      if (result.content.length === 0) {
        return result;
      }

      // Handle case: set tool choice type "tool" and tool name
      if (
        typeof params.providerOptions === "object" &&
        params.providerOptions !== null &&
        typeof (params.providerOptions as any).toolCallMiddleware ===
          "object" &&
        (params.providerOptions as any).toolCallMiddleware?.toolChoice &&
        typeof (params.providerOptions as any).toolCallMiddleware.toolChoice ===
          "object" &&
        ((params.providerOptions as any).toolCallMiddleware.toolChoice.type ===
          "tool" ||
          (params.providerOptions as any).toolCallMiddleware.toolChoice.type ===
            "required")
      ) {
        const toolJson: any =
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
              toolName: toolJson.name,
              args: JSON.stringify(toolJson.arguments || {}),
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
        const selectedTool = params.tools?.find(
          (tool) => tool.name === selectedToolName
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
                arguments: selectedTool.parameters,
              },
              required: ["name", "arguments"],
            },
            name: selectedTool.name,
            description: selectedTool.description,
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

const createDynamicIfThenElseSchema = (
  tools: (LanguageModelV2FunctionTool | LanguageModelV2ProviderDefinedTool)[]
): JSONSchema7 => {
  // Explicitly specify the return type as JSONSchema7
  let currentSchema: JSONSchema7 = {};
  const toolNames: string[] = [];

  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i];

    if (tool.type === "provider-defined") {
      throw new Error(
        "Provider-defined tools are not supported by this middleware. Please use custom tools."
      );
    }

    toolNames.unshift(tool.name);

    const toolCondition: JSONSchema7 = {
      if: {
        properties: {
          name: {
            const: tool.name,
          },
        },
        required: ["name"],
      },
      then: {
        properties: {
          name: {
            const: tool.name,
          },
          // Cast tool.parameters to JSONSchema7 here.
          arguments: tool.parameters as JSONSchema7,
        },
        required: ["name", "arguments"],
      },
    };

    if (Object.keys(currentSchema).length > 0) {
      toolCondition.else = currentSchema;
    }

    currentSchema = toolCondition;
  }

  return {
    type: "object", // Explicitly specify type as "object"
    properties: {
      name: {
        type: "string",
        description: "Name of the tool to call",
        enum: toolNames,
      },
      arguments: {
        type: "object", // By default, arguments is also specified as object type
        description: "Argument object to be passed to the tool",
      },
    },
    required: ["name", "arguments"],
    ...currentSchema,
  };
};
