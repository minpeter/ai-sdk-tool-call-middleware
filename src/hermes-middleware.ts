import { generateId, LanguageModelV1Middleware } from "ai";
import * as RJSON from "relaxed-json";

export const hermesToolMiddleware: LanguageModelV1Middleware = {
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
    // Appropriate fixes are needed as they are disappearing in LanguageModelV2
    const originalToolDefinitions =
      params.mode.type === "regular" && params.mode.tools
        ? params.mode.tools
        : {};

    const processedPrompt = params.prompt.map((message) => {
      if (message.role === "tool") {
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
              content: HermesPrompt + processedPrompt[0].content,
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
