import type {
  LanguageModelV2Middleware,
  LanguageModelV2ToolCall,
  LanguageModelV2Content,
  LanguageModelV2Prompt,
  LanguageModelV2FunctionTool,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";
import { XMLParser } from "fast-xml-parser";

import { createDynamicIfThenElseSchema } from "./utils";
import { normalToolStream, toolChoiceStream } from "./stream-handler";
import { ToolCallProtocol } from "./protocols/tool-call-protocol";

function isProtocolFactory(
  protocol: ToolCallProtocol | (() => ToolCallProtocol)
): protocol is () => ToolCallProtocol {
  return typeof protocol === "function";
}

function isToolChoiceActive(params: {
  providerOptions?: {
    toolCallMiddleware?: {
      toolChoice?: { type: string };
    };
  };
}): boolean {
  const toolChoice = params.providerOptions?.toolCallMiddleware?.toolChoice;
  return !!(
    typeof params.providerOptions === "object" &&
    params.providerOptions !== null &&
    typeof params.providerOptions?.toolCallMiddleware === "object" &&
    toolChoice &&
    typeof toolChoice === "object" &&
    (toolChoice.type === "tool" || toolChoice.type === "required")
  );
}

export function createToolMiddleware({
  protocol,
  toolSystemPromptTemplate,
}: {
  protocol: ToolCallProtocol | (() => ToolCallProtocol);
  toolSystemPromptTemplate: (tools: string) => string;
}): LanguageModelV2Middleware {
  const resolvedProtocol = isProtocolFactory(protocol) ? protocol() : protocol;
  type ProviderOptionsWithToolNames = {
    toolCallMiddleware?: { toolNames?: string[] };
  };
  function getFunctionTools(params: {
    tools?: Array<LanguageModelV2FunctionTool | { type: string }>;
    providerOptions?: unknown;
  }): LanguageModelV2FunctionTool[] {
    const rawToolNames =
      (params.providerOptions &&
        typeof params.providerOptions === "object" &&
        (params.providerOptions as ProviderOptionsWithToolNames)
          .toolCallMiddleware?.toolNames) ||
      [];
    const toolNames: string[] = Array.isArray(rawToolNames)
      ? (rawToolNames as unknown[]).filter(
          (n): n is string => typeof n === "string"
        )
      : [];
    if (toolNames.length > 0) {
      return toolNames.map((name: string) => ({
        type: "function",
        name,
        description: "",
        inputSchema: { type: "object" },
      }));
    }
    return (params.tools ?? []).filter(
      (t): t is LanguageModelV2FunctionTool =>
        (t as { type: string }).type === "function"
    );
  }
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
          })
        ),
        ...rest,
      };
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      if (isToolChoiceActive(params)) {
        const result = await doGenerate();
        const toolJson: { name?: string; arguments?: Record<string, unknown> } =
          result.content[0].type === "text"
            ? JSON.parse(result.content[0].text)
            : {};

        return {
          ...result,
          content: [
            {
              type: "tool-call",
              toolCallId: generateId(),
              toolName: toolJson.name || "unknown",
              input: JSON.stringify(toolJson.arguments || {}),
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
              if (content.type === "tool-call") {
                newContent.push({
                  type: "text",
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  text: resolvedProtocol.formatToolCall(content as any),
                });
              } else {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                newContent.push(content as any);
              }
            }
            return { role: "assistant", content: newContent };
          }
          if (message.role === "tool") {
            return {
              role: "user",
              content: message.content.map(toolResult => ({
                type: "text",
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                text: resolvedProtocol.formatToolResponse(toolResult as any),
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
