import type {
  JSONSchema7,
  LanguageModelV2Content,
  LanguageModelV2FunctionTool,
  LanguageModelV2Prompt,
  LanguageModelV2ToolResultPart,
} from "@ai-sdk/provider";

import {
  isProtocolFactory,
  type ToolCallProtocol,
} from "./protocols/tool-call-protocol";
import {
  createDynamicIfThenElseSchema,
  extractOnErrorOption,
  isToolCallContent,
  isToolResultPart,
  originalToolsSchema,
  type ToolCallMiddlewareProviderOptions,
} from "./utils";

/**
 * Build final prompt by merging system prompt with existing prompt
 */
function buildFinalPrompt(
  systemPrompt: string,
  processedPrompt: LanguageModelV2Prompt
): LanguageModelV2Prompt {
  if (processedPrompt[0]?.role === "system") {
    return [
      {
        role: "system",
        content: `${systemPrompt}\n\n${processedPrompt[0].content}`,
      },
      ...processedPrompt.slice(1),
    ];
  }
  return [
    {
      role: "system",
      content: systemPrompt,
    },
    ...processedPrompt,
  ];
}

/**
 * Build base return parameters with middleware options
 */
function buildBaseReturnParams(
  params: {
    prompt?: LanguageModelV2Prompt;
    tools?: Array<LanguageModelV2FunctionTool | { type: string }>;
    providerOptions?: unknown;
    toolChoice?: { type: string; toolName?: string };
  },
  finalPrompt: LanguageModelV2Prompt,
  functionTools: LanguageModelV2FunctionTool[]
) {
  return {
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
        originalTools: originalToolsSchema.encode(functionTools),
      } as ToolCallMiddlewareProviderOptions,
    },
  };
}

/**
 * Find provider-defined tool matching the selected tool name
 */
function findProviderDefinedTool(
  tools: Array<LanguageModelV2FunctionTool | { type: string }>,
  selectedToolName: string
) {
  return tools.find((t) => {
    if (t.type === "function") {
      return false;
    }
    const anyTool = t as unknown as { id?: string; name?: string };
    return anyTool.id === selectedToolName || anyTool.name === selectedToolName;
  });
}

/**
 * Handle tool choice type 'tool'
 */
function handleToolChoiceTool(
  params: {
    tools?: Array<LanguageModelV2FunctionTool | { type: string }>;
    toolChoice?: { type: string; toolName?: string };
  },
  baseReturnParams: ReturnType<typeof buildBaseReturnParams>
) {
  const selectedToolName = params.toolChoice?.toolName;
  if (!selectedToolName) {
    throw new Error("Tool name is required for 'tool' toolChoice type.");
  }

  const providerDefinedMatch = findProviderDefinedTool(
    params.tools ?? [],
    selectedToolName
  );
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
        toolChoice: params.toolChoice,
      },
    },
  };
}

/**
 * Handle tool choice type 'required'
 */
function handleToolChoiceRequired(
  params: {
    tools?: Array<LanguageModelV2FunctionTool | { type: string }>;
    toolChoice?: { type: string; toolName?: string };
  },
  baseReturnParams: ReturnType<typeof buildBaseReturnParams>,
  functionTools: LanguageModelV2FunctionTool[]
) {
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
        toolChoice: { type: "required" },
      },
    },
  };
}

export function transformParams({
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

  const finalPrompt = buildFinalPrompt(systemPrompt, processedPrompt);
  const baseReturnParams = buildBaseReturnParams(
    params,
    finalPrompt,
    functionTools
  );

  if (params.toolChoice?.type === "none") {
    throw new Error(
      "The 'none' toolChoice type is not supported by this middleware. Please use 'auto', 'required', or specify a tool name."
    );
  }

  if (params.toolChoice?.type === "tool") {
    return handleToolChoiceTool(params, baseReturnParams);
  }

  if (params.toolChoice?.type === "required") {
    return handleToolChoiceRequired(params, baseReturnParams, functionTools);
  }

  return baseReturnParams;
}

/**
 * Process assistant message content
 */
function processAssistantContent(
  content: LanguageModelV2Content[],
  resolvedProtocol: ToolCallProtocol,
  providerOptions?: {
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
  }
): LanguageModelV2Content[] {
  const newContent: LanguageModelV2Content[] = [];
  for (const item of content) {
    if (isToolCallContent(item)) {
      newContent.push({
        type: "text",
        text: resolvedProtocol.formatToolCall(item),
      });
    } else if ((item as { type?: string }).type === "text") {
      newContent.push(item as LanguageModelV2Content);
    } else if ((item as { type?: string }).type === "reasoning") {
      newContent.push(item as LanguageModelV2Content);
    } else {
      const options = extractOnErrorOption(providerOptions);
      options?.onError?.(
        "tool-call-middleware: unknown assistant content; stringifying for provider compatibility",
        { content: item }
      );
      newContent.push({
        type: "text",
        text: JSON.stringify(item),
      });
    }
  }

  // Condense if all content is text
  const onlyText = newContent.every((c) => c.type === "text");
  return onlyText
    ? [
        {
          type: "text" as const,
          text: newContent.map((c) => (c as { text: string }).text).join("\n"),
        },
      ]
    : newContent;
}

/**
 * Process tool message content
 */
function processToolMessage(
  content: LanguageModelV2Content[],
  resolvedProtocol: ToolCallProtocol
) {
  return {
    role: "user" as const,
    content: [
      {
        type: "text" as const,
        text: content
          .map((toolResult) =>
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

/**
 * Process a single message in the prompt
 */
function processMessage(
  message: LanguageModelV2Prompt[number],
  resolvedProtocol: ToolCallProtocol,
  providerOptions?: {
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
  }
): LanguageModelV2Prompt[number] {
  if (message.role === "assistant") {
    const condensedContent = processAssistantContent(
      message.content,
      resolvedProtocol,
      providerOptions
    );
    return { role: "assistant", content: condensedContent };
  }
  if (message.role === "tool") {
    return processToolMessage(message.content, resolvedProtocol);
  }
  return message;
}

/**
 * Check if all content parts are text
 */
function isAllTextContent(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return false;
  }
  return (content as { type: string }[]).every(
    (c: { type: string }) => c?.type === "text"
  );
}

/**
 * Join text content parts into a single string
 */
function joinTextContent(content: { text: string }[]): string {
  return content.map((c) => c.text).join("\n");
}

/**
 * Create condensed message based on role
 */
function createCondensedMessage(role: string, joinedText: string) {
  if (role === "system") {
    return {
      role: "system" as const,
      content: joinedText,
    };
  }
  
  return {
    role: role as "assistant" | "user",
    content: [
      {
        type: "text" as const,
        text: joinedText,
      },
    ],
  };
}

/**
 * Condense multi-part text content into single text part
 */
function condenseTextContent(
  processedPrompt: LanguageModelV2Prompt
): LanguageModelV2Prompt {
  for (let i = 0; i < processedPrompt.length; i++) {
    const msg = processedPrompt[i] as unknown as {
      role: string;
      content: unknown;
    };
    
    if (!Array.isArray(msg.content)) {
      continue;
    }
    
    const shouldCondense = isAllTextContent(msg.content) && msg.content.length > 1;
    if (shouldCondense) {
      const joinedText = joinTextContent(msg.content as { text: string }[]);
      processedPrompt[i] = createCondensedMessage(msg.role, joinedText);
    }
  }
  return processedPrompt;
}

/**
 * Merge consecutive user messages
 */
function mergeConsecutiveUserMessages(
  processedPrompt: LanguageModelV2Prompt
): LanguageModelV2Prompt {
  for (let i = processedPrompt.length - 1; i > 0; i--) {
    const current = processedPrompt[i];
    const prev = processedPrompt[i - 1];
    if (current.role === "user" && prev.role === "user") {
      const prevContent = prev.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("\n");
      const currentContent = current.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("\n");
      processedPrompt[i - 1] = {
        role: "user",
        content: [{ type: "text", text: `${prevContent}\n${currentContent}` }],
      };
      processedPrompt.splice(i, 1);
    }
  }
  return processedPrompt;
}

function convertToolPrompt(
  prompt: LanguageModelV2Prompt,
  resolvedProtocol: ToolCallProtocol,
  providerOptions?: {
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
  }
): LanguageModelV2Prompt {
  let processedPrompt = prompt.map((message) =>
    processMessage(message, resolvedProtocol, providerOptions)
  );

  processedPrompt = condenseTextContent(processedPrompt);
  processedPrompt = mergeConsecutiveUserMessages(processedPrompt);
  return processedPrompt as LanguageModelV2Prompt;
}
