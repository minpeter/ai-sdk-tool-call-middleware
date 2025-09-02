import type { JSONSchema7 } from "@ai-sdk/provider";
import {
  LanguageModelV2Content,
  LanguageModelV2FunctionTool,
  LanguageModelV2Prompt,
  LanguageModelV2ToolResultPart,
} from "@ai-sdk/provider";

import {
  isProtocolFactory,
  ToolCallProtocol,
} from "./protocols/tool-call-protocol";
import {
  createDynamicIfThenElseSchema,
  extractOnErrorOption,
  isToolCallContent,
  isToolResultPart,
  originalToolsSchema,
  ToolCallMiddlewareProviderOptions,
} from "./utils";

export async function transformParams({
  params,
  protocol,
  toolSystemPromptTemplate,
}: {
  params: {
    prompt?: LanguageModelV2Prompt;
    tools?: Array<LanguageModelV2FunctionTool | { type: string }>;
    providerOptions?: {
      toolCallMiddleware?: {
        toolChoice?: { type: string };
      };
    };
    toolChoice?: { type: string; toolName?: string };
  };
  protocol: ToolCallProtocol | (() => ToolCallProtocol);
  toolSystemPromptTemplate: (tools: string) => string;
}) {
  const resolvedProtocol = isProtocolFactory(protocol) ? protocol() : protocol;

  const functionTools = (params.tools ?? []).filter(
    (t): t is LanguageModelV2FunctionTool => t.type === "function"
  );

  const systemPrompt = resolvedProtocol.formatTools({
    tools: functionTools,
    toolSystemPromptTemplate,
  });

  const processedPrompt = convertToolPrompt(
    params.prompt ?? [],
    resolvedProtocol,
    extractOnErrorOption(params.providerOptions)
  );

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

        // INTERNAL: used by the middleware so downstream parsers can access
        // the original tool schemas even if providers strip `params.tools`.
        // Not a stable public API.
        originalTools: originalToolsSchema.encode(functionTools),
      } as ToolCallMiddlewareProviderOptions,
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
    // If a provider-defined tool matches the requested tool identifier, surface the specific error
    const providerDefinedMatch = (params.tools ?? []).find(t => {
      if (t.type === "function") return false;
      const anyTool = t as unknown as { id?: string; name?: string };
      return (
        anyTool.id === selectedToolName || anyTool.name === selectedToolName
      );
    });
    if (providerDefinedMatch) {
      throw new Error(
        "Provider-defined tools are not supported by this middleware. Please use custom tools."
      );
    }

    const selectedTool = (params.tools ?? []).find(
      (t): t is LanguageModelV2FunctionTool =>
        t.type === "function" &&
        (t as LanguageModelV2FunctionTool).name === selectedToolName
    );

    if (!selectedTool) {
      throw new Error(
        `Tool with name '${selectedToolName}' not found in params.tools.`
      );
    }

    return {
      ...baseReturnParams,
      responseFormat: {
        type: "json" as const,
        schema: {
          type: "object",
          properties: {
            name: {
              const: selectedTool.name,
            },
            arguments: selectedTool.inputSchema,
          },
          required: ["name", "arguments"],
        } as JSONSchema7,
        name: selectedTool.name,
        description:
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
          // INTERNAL: used by the middleware to activate the tool-choice
          // fast-path in handlers. Not a stable public API.
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
        type: "json" as const,
        schema: createDynamicIfThenElseSchema(functionTools),
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
          // INTERNAL: used by the middleware to activate the tool-choice
          // fast-path in handlers. Not a stable public API.
          toolChoice: { type: "required" },
        },
      },
    };
  }

  return baseReturnParams;
}

function convertToolPrompt(
  prompt: LanguageModelV2Prompt,
  resolvedProtocol: ToolCallProtocol,
  providerOptions?: {
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
  }
): LanguageModelV2Prompt {
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
          const options = extractOnErrorOption(providerOptions);
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
              text: newContent
                .map(c => (c as { text: string }).text)
                .join("\n"),
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
      content: unknown;
    };
    if (Array.isArray(msg.content)) {
      const allText = (msg.content as { type: string }[]).every(
        (c: { type: string }) => c?.type === "text"
      );
      if (allText && msg.content.length > 1) {
        const joinedText = (msg.content as { text: string }[])
          .map((c: { text: string }) => c.text)
          .join("\n");
        if (msg.role === "system") {
          processedPrompt[i] = {
            role: "system",
            content: joinedText,
          };
        } else if (msg.role === "assistant") {
          processedPrompt[i] = {
            role: "assistant",
            content: [
              {
                type: "text" as const,
                text: joinedText,
              },
            ],
          };
        } else {
          // Treat remaining roles (e.g., user) as user text content
          processedPrompt[i] = {
            role: "user",
            content: [
              {
                type: "text" as const,
                text: joinedText,
              },
            ],
          };
        }
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
        content: [{ type: "text", text: prevContent + "\n" + currentContent }],
      };
      processedPrompt.splice(i, 1);
    }
  }
  return processedPrompt as LanguageModelV2Prompt;
}
