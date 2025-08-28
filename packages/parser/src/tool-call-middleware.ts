import type {
  LanguageModelV2Middleware,
  LanguageModelV2Content,
  LanguageModelV2Prompt,
  LanguageModelV2ToolResultPart,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";

import {
  createDynamicIfThenElseSchema,
  isToolCallContent,
  isToolResultPart,
} from "./utils";
import { toolChoiceStream } from "./stream-handler";
import { ToolCallProtocol } from "./protocols/tool-call-protocol";
import {
  isToolChoiceActive,
  getFunctionTools,
  extractOnErrorOption,
} from "./utils";

function isProtocolFactory(
  protocol: ToolCallProtocol | (() => ToolCallProtocol)
): protocol is () => ToolCallProtocol {
  return typeof protocol === "function";
}

export function createToolMiddleware({
  protocol,
  toolSystemPromptTemplate,
}: {
  protocol: ToolCallProtocol | (() => ToolCallProtocol);
  toolSystemPromptTemplate: (tools: string) => string;
}): LanguageModelV2Middleware {
  const resolvedProtocol = isProtocolFactory(protocol) ? protocol() : protocol;
  return {
    middlewareVersion: "v2",
    wrapStream: async ({ doStream, doGenerate, params }) => {
      if (isToolChoiceActive(params)) {
        return toolChoiceStream({ doGenerate });
      }

      const { stream, ...rest } = await doStream();
      return {
        stream: stream.pipeThrough(
          resolvedProtocol.createStreamParser({
            tools: getFunctionTools(params),
            options: extractOnErrorOption(params.providerOptions),
          })
        ),
        ...rest,
      };
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      if (isToolChoiceActive(params)) {
        const result = await doGenerate();
        let parsed: { name?: string; arguments?: Record<string, unknown> } = {};
        const first = result.content?.[0];
        if (first && first.type === "text") {
          try {
            parsed = JSON.parse(first.text);
          } catch {
            parsed = {};
          }
        }

        return {
          ...result,
          content: [
            {
              type: "tool-call",
              toolCallId: generateId(),
              toolName: parsed.name || "unknown",
              input: JSON.stringify(parsed.arguments || {}),
            },
          ],
        };
      }

      const result = await doGenerate();

      if (result.content.length === 0) {
        return result;
      }

      const newContent = result.content.flatMap(contentItem => {
        if (contentItem.type !== "text") {
          return [contentItem];
        }
        return resolvedProtocol.parseGeneratedText({
          text: contentItem.text,
          tools: getFunctionTools(params),
          options: extractOnErrorOption(params.providerOptions),
        });
      });

      return {
        ...result,
        content: newContent,
      };
    },

    transformParams: async ({ params }) => {
      const convertToolPrompt = (
        prompt: LanguageModelV2Prompt
      ): LanguageModelV2Prompt => {
        const processedPrompt = prompt.map(message => {
          if (message.role === "assistant") {
            const newContent: LanguageModelV2Content[] = [];
            for (const content of message.content) {
              if (isToolCallContent(content)) {
                newContent.push({
                  type: "text",
                  text: resolvedProtocol.formatToolCall(content),
                });
              } else if ((content as { type?: string }).type === "text") {
                newContent.push(content as LanguageModelV2Content);
              } else {
                newContent.push({
                  type: "text",
                  text: JSON.stringify(content),
                });
              }
            }
            return { role: "assistant", content: newContent };
          }
          if (message.role === "tool") {
            return {
              role: "user",
              content: message.content.map(toolResult => ({
                type: "text",
                text: isToolResultPart(toolResult)
                  ? resolvedProtocol.formatToolResponse(toolResult)
                  : resolvedProtocol.formatToolResponse(
                      toolResult as LanguageModelV2ToolResultPart
                    ),
              })),
            };
          }
          return message;
        });

        // Merge consecutive text blocks
        for (let i = processedPrompt.length - 1; i > 0; i--) {
          const current = processedPrompt[i];
          const prev = processedPrompt[i - 1];
          if (current.role === "user" && prev.role === "user") {
            const prevContent = prev.content
              .map(c => (c.type === "text" ? c.text : ""))
              .join("\n");
            const currentContent = current.content
              .map(c => (c.type === "text" ? c.text : ""))
              .join("\n");
            processedPrompt[i - 1] = {
              role: "user",
              content: [
                { type: "text", text: prevContent + "\n" + currentContent },
              ],
            };
            processedPrompt.splice(i, 1);
          }
        }
        return processedPrompt as LanguageModelV2Prompt;
      };

      const functionTools = (params.tools ?? []).filter(
        t => t.type === "function"
      );

      const systemPrompt = resolvedProtocol.formatTools({
        tools: functionTools,
        toolSystemPromptTemplate,
      });
      const processedPrompt = convertToolPrompt(params.prompt);

      const finalPrompt: LanguageModelV2Prompt =
        processedPrompt[0]?.role === "system"
          ? [
              {
                role: "system",
                content: systemPrompt + "\n\n" + processedPrompt[0].content,
              },
              ...processedPrompt.slice(1),
            ]
          : [
              {
                role: "system",
                content: systemPrompt,
              },
              ...processedPrompt,
            ];

      const baseReturnParams = {
        ...params,
        prompt: finalPrompt,
        tools: [],
        toolChoice: undefined,
        providerOptions: {
          ...(params.providerOptions || {}),
          toolCallMiddleware: {
            ...((params.providerOptions &&
              typeof params.providerOptions === "object" &&
              (params.providerOptions as { toolCallMiddleware?: unknown })
                .toolCallMiddleware) ||
              {}),
            toolNames: functionTools.map(t => t.name),
          },
        },
      };

      if (params.toolChoice?.type === "none") {
        // TODO: Support 'none' toolChoice type.
        throw new Error(
          "The 'none' toolChoice type is not supported by this middleware. Please use 'auto', 'required', or specify a tool name."
        );
      }

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
            ...(baseReturnParams.providerOptions || {}),
            toolCallMiddleware: {
              ...((baseReturnParams.providerOptions &&
                typeof baseReturnParams.providerOptions === "object" &&
                (
                  baseReturnParams.providerOptions as {
                    toolCallMiddleware?: unknown;
                  }
                ).toolCallMiddleware) ||
                {}),
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
            schema: createDynamicIfThenElseSchema(
              params.tools.filter(t => t.type === "function")
            ),
          },
          providerOptions: {
            ...(baseReturnParams.providerOptions || {}),
            toolCallMiddleware: {
              ...((baseReturnParams.providerOptions &&
                typeof baseReturnParams.providerOptions === "object" &&
                (
                  baseReturnParams.providerOptions as {
                    toolCallMiddleware?: unknown;
                  }
                ).toolCallMiddleware) ||
                {}),
              toolChoice: { type: "required" },
            },
          },
        };
      }

      return baseReturnParams;
    },
  };
}
