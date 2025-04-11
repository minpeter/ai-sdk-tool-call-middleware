import {
  generateId,
  LanguageModelV1Middleware,
  LanguageModelV1StreamPart,
} from "ai";
import * as RJSON from "relaxed-json";

export function hermesToolMiddleware({
  tagName,
}: {
  tagName: string;
}): LanguageModelV1Middleware {
  const openingTag = `<${tagName}>`;
  const closingTag = `<\/${tagName}>`;

  return {
    middlewareVersion: "v1",
    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream();

      let isFirstToolCalling = true;
      let isFirstText = true;
      let afterSwitch = false;
      let isToolCalling = false;
      let buffer = "";

      const transformStream = new TransformStream<
        LanguageModelV1StreamPart,
        LanguageModelV1StreamPart
      >({
        transform(chunk, controller) {
          if (chunk.type !== "text-delta") {
            controller.enqueue(chunk);
            return;
          }

          buffer += chunk.textDelta;

          function publish(text: string) {
            if (text.length > 0) {
              const prefix =
                afterSwitch &&
                (isToolCalling ? !isFirstToolCalling : !isFirstText)
                  ? "\n" // separator
                  : "";

              controller.enqueue({
                type: isToolCalling ? "reasoning" : "text-delta",
                textDelta: prefix + text,
              });
              afterSwitch = false;

              if (isToolCalling) {
                isFirstToolCalling = false;
              } else {
                isFirstText = false;
              }
            }
          }

          do {
            const nextTag = isToolCalling ? closingTag : openingTag;
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
              isToolCalling = !isToolCalling;
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

      if (!result.text?.includes("<tool_call>")) {
        return result;
      }

      const toolCallRegex = /<tool_call>(.*?)<\/tool_call>|<tool_call>(.*)/gs;
      const matches = [...result.text.matchAll(toolCallRegex)];
      const function_call_tuples = matches.map((match) => match[1] || match[2]);

      return {
        ...result,
        // TODO: Return the remaining value after extracting the tool call tag.
        text: "",
        toolCalls: function_call_tuples.map((toolCall) => {
          const parsedToolCall = RJSON.parse(toolCall) as {
            name: string;
            arguments: string;
          };

          const toolName = parsedToolCall.name;
          const args = parsedToolCall.arguments;

          return {
            toolCallType: "function",
            toolCallId: generateId(),
            toolName: toolName,
            args: RJSON.stringify(args),
          };
        }),
      };
    },

    // @ts-ignore
    transformParams: async ({ params }) => {
      const processedPrompt = params.prompt.map((message) => {
        if (message.role === "assistant") {
          return {
            role: "assistant",
            content: message.content.map((content) => {
              if (content.type === "tool-call") {
                return {
                  type: "text",
                  text: `<tool_call>${JSON.stringify({
                    arguments: content.args,
                    name: content.toolName,
                  })}</tool_call>`,
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
                      `<tool_response>${JSON.stringify({
                        toolName: content.toolName,
                        result: content.result,
                      })}</tool_response>`
                  )
                  .join("\n"),
              },
            ],
          };
        }

        return message;
      });

      // Appropriate fixes are needed as they are disappearing in LanguageModelV2
      const originalToolDefinitions =
        params.mode.type === "regular" && params.mode.tools
          ? params.mode.tools
          : {};

      const HermesPromptFormat = (tools: string) =>
        `You are a function calling AI model. You are provided with function signatures within <tools></tools> XML tags. You may call one or more functions to assist with the user query. Don't make assumptions about what values to plug into functions. Here are the available tools: <tools>` +
        tools +
        `</tools> Use the following pydantic model json schema for each tool call you will make: {'title': 'FunctionCall', 'type': 'object', 'properties': {'arguments': {'title': 'Arguments', 'type': 'object'}, 'name': {'title': 'Name', 'type': 'string'}}, 'required': ['arguments', 'name']} For each function call return a json object with function name and arguments within <tool_call></tool_call> XML tags as follows:
      <tool_call>
      {'arguments': <args-dict>, 'name': <function-name>}
      </tool_call>`;

      const HermesPrompt = HermesPromptFormat(
        JSON.stringify(Object.entries(originalToolDefinitions))
      );

      const toolSystemPrompt =
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
        mode: {
          // Here, set the mode back to regular and remove the default tools.
          type: "regular",
        },
        //   stopSequences: ["</tool_call>", ...(params.stopSequences || [])],
        prompt: toolSystemPrompt,
      };
    },
  };
}

/**
 * Returns the index of the start of the searchedText in the text, or null if it
 * is not found.
 * ref: https://github.com/vercel/ai/blob/452bf12f0be9cb398d4af85a006bca13c8ce36d8/packages/ai/core/util/get-potential-start-index.ts
 */
export function getPotentialStartIndex(
  text: string,
  searchedText: string
): number | null {
  // Return null immediately if searchedText is empty.
  if (searchedText.length === 0) {
    return null;
  }

  // Check if the searchedText exists as a direct substring of text.
  const directIndex = text.indexOf(searchedText);
  if (directIndex !== -1) {
    return directIndex;
  }

  // Otherwise, look for the largest suffix of "text" that matches
  // a prefix of "searchedText". We go from the end of text inward.
  for (let i = text.length - 1; i >= 0; i--) {
    const suffix = text.substring(i);
    if (searchedText.startsWith(suffix)) {
      return i;
    }
  }

  return null;
}
