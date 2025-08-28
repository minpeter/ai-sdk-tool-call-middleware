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

function getSchemaType(schema: unknown): string | undefined {
  const unwrapped = unwrapJsonSchema(schema);
  if (!unwrapped || typeof unwrapped !== "object") return undefined;
  const t: unknown = (unwrapped as Record<string, unknown>).type;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) {
    const preferred = [
      "object",
      "array",
      "boolean",
      "number",
      "integer",
      "string",
    ];
    for (const p of preferred) if (t.includes(p)) return p;
  }
  return undefined;
}

function coerceBySchema(value: unknown, schema?: unknown): unknown {
  const unwrapped = unwrapJsonSchema(schema);
  if (!unwrapped || typeof unwrapped !== "object") return value;
  const schemaType = getSchemaType(unwrapped);
  if (
    schemaType === "object" &&
    (unwrapped as Record<string, unknown>).properties &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const out: Record<string, unknown> = {};
    const props = (unwrapped as Record<string, unknown>).properties as
      | Record<string, unknown>
      | undefined;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const propSchema = props ? (props[k] as unknown) : undefined;
      out[k] =
        typeof propSchema === "boolean" ? v : coerceBySchema(v, propSchema);
    }
    return out;
  }
  if (schemaType === "array" && Array.isArray(value)) {
    const itemsSchema = (unwrapped as Record<string, unknown>).items as unknown;
    return value.map(v => coerceBySchema(v, itemsSchema));
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (schemaType === "boolean") {
      const lower = s.toLowerCase();
      if (lower === "true") return true;
      if (lower === "false") return false;
    }
    if (schemaType === "number" || schemaType === "integer") {
      if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s)) {
        const num = Number(s);
        if (Number.isFinite(num)) return num;
      }
    }
  }
  return value;
}

function unwrapJsonSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  const s = schema as Record<string, unknown>;
  if (s.jsonSchema && typeof s.jsonSchema === "object") {
    return unwrapJsonSchema(s.jsonSchema);
  }
  return schema;
}

function coerceToolCallInput(
  part: LanguageModelV2Content,
  tools: ReturnType<typeof getFunctionTools>
): LanguageModelV2Content {
  if ((part as { type?: string }).type !== "tool-call") return part;
  const tc = part as unknown as {
    toolName: string;
    input: unknown;
  };
  let args: unknown = {};
  if (typeof tc.input === "string") {
    try {
      args = JSON.parse(tc.input);
    } catch {
      return part;
    }
  } else if (tc.input && typeof tc.input === "object") {
    args = tc.input;
  }
  const schema = tools.find(t => t.name === tc.toolName)
    ?.inputSchema as unknown;
  const coerced = coerceBySchema(args, schema);
  return {
    ...(part as Record<string, unknown>),
    input: JSON.stringify(coerced ?? {}),
  } as LanguageModelV2Content;
}

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
        return toolChoiceStream({
          doGenerate,
          options: extractOnErrorOption(params.providerOptions),
        });
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
          } catch (error) {
            const options = extractOnErrorOption(params.providerOptions);
            options?.onError?.(
              "Failed to parse toolChoice JSON from generated model output",
              {
                text: first.text,
                error: error instanceof Error ? error.message : String(error),
              }
            );
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

      const parsed = result.content.flatMap(contentItem => {
        if (contentItem.type !== "text") {
          return [contentItem];
        }
        return resolvedProtocol.parseGeneratedText({
          text: contentItem.text,
          tools: getFunctionTools(params),
          options: extractOnErrorOption(params.providerOptions),
        });
      });
      const tools = getFunctionTools(params);
      const newContent = parsed.map(part =>
        coerceToolCallInput(part as LanguageModelV2Content, tools)
      );

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
              } else if ((content as { type?: string }).type === "reasoning") {
                // Pass through reasoning parts unchanged for providers that support it
                newContent.push(content as LanguageModelV2Content);
              } else {
                // Prefer the onError callback for surfacing non-fatal warnings
                const options = extractOnErrorOption(params.providerOptions);
                options?.onError?.(
                  "tool-call-middleware: unknown assistant content; stringifying for provider compatibility",
                  { content }
                );
                newContent.push({
                  type: "text",
                  text: JSON.stringify(content),
                });
              }
            }
            // If assistant content consists solely of text parts, condense into a single text part
            const onlyText = newContent.every(c => c.type === "text");
            const condensedAssistant = onlyText
              ? [
                  {
                    type: "text" as const,
                    text: newContent.map(c => (c as any).text).join("\n"),
                  },
                ]
              : newContent;
            return { role: "assistant", content: condensedAssistant };
          }
          if (message.role === "tool") {
            return {
              role: "user",
              // Map tool results to text response blocks, then condense into a single text block
              content: [
                {
                  type: "text" as const,
                  text: message.content
                    .map(toolResult =>
                      isToolResultPart(toolResult)
                        ? resolvedProtocol.formatToolResponse(toolResult)
                        : resolvedProtocol.formatToolResponse(
                            toolResult as LanguageModelV2ToolResultPart
                          )
                    )
                    .join("\n"),
                },
              ],
            };
          }
          return message;
        });

        // Condense any message that contains only text parts into a single text part
        for (let i = 0; i < processedPrompt.length; i++) {
          const msg = processedPrompt[i] as unknown as {
            role: string;
            content: any;
          };
          if (Array.isArray(msg.content)) {
            const allText = msg.content.every((c: any) => c?.type === "text");
            if (allText && msg.content.length > 1) {
              processedPrompt[i] = {
                role: msg.role as any,
                content: [
                  {
                    type: "text",
                    text: msg.content.map((c: any) => c.text).join("\n"),
                  },
                ],
              } as any;
            }
          }
        }

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
