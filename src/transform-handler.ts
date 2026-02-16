import type {
  JSONSchema7,
  LanguageModelV3Content,
  LanguageModelV3FilePart,
  LanguageModelV3FunctionTool,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3ReasoningPart,
  LanguageModelV3TextPart,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolResultPart,
  SharedV3ProviderOptions,
} from "@ai-sdk/provider";
import type { ToolContent, ToolResultPart } from "@ai-sdk/provider-utils";
import {
  assistantToolCallsToTextContent,
  toolRoleContentToUserTextMessage,
} from "./core/prompts/shared";
import type { TCMCoreProtocol } from "./core/protocols/protocol-interface";
import { isTCMProtocolFactory } from "./core/protocols/protocol-interface";
import { createDynamicIfThenElseSchema } from "./core/utils/dynamic-tool-schema";
import { extractOnErrorOption } from "./core/utils/on-error";
import { originalToolsSchema } from "./core/utils/provider-options";

/**
 * Build final prompt by merging system prompt with existing prompt
 */
function buildFinalPrompt(
  systemPrompt: string,
  processedPrompt: LanguageModelV3Prompt,
  placement: "first" | "last"
): LanguageModelV3Prompt {
  const systemIndex = processedPrompt.findIndex((m) => m.role === "system");
  if (systemIndex !== -1) {
    const existing = processedPrompt[systemIndex].content as unknown;
    let existingText = "";
    if (typeof existing === "string") {
      existingText = existing;
    } else if (Array.isArray(existing)) {
      existingText = (existing as { type?: string; text?: string }[])
        .map((p) => (p?.type === "text" ? (p.text ?? "") : ""))
        .filter(Boolean)
        .join("\n");
    } else {
      existingText = String(existing ?? "");
    }

    const mergedContent =
      placement === "first"
        ? `${systemPrompt}\n\n${existingText}`
        : `${existingText}\n\n${systemPrompt}`;

    return processedPrompt.map((m, idx) =>
      idx === systemIndex
        ? {
            ...m,
            content: mergedContent,
          }
        : m
    ) as LanguageModelV3Prompt;
  }
  if (placement === "first") {
    return [
      {
        role: "system",
        content: systemPrompt,
      },
      ...processedPrompt,
    ];
  }
  // placement === 'last'
  return [
    ...processedPrompt,
    {
      role: "system",
      content: systemPrompt,
    },
  ];
}

/**
 * Build base return parameters with middleware options
 */
function buildBaseReturnParams(
  params: {
    prompt?: LanguageModelV3Prompt;
    tools?: Array<LanguageModelV3FunctionTool | { type: string }>;
    providerOptions?: unknown;
    toolChoice?: { type: string; toolName?: string };
  },
  finalPrompt: LanguageModelV3Prompt,
  functionTools: LanguageModelV3FunctionTool[]
) {
  return {
    ...params,
    prompt: finalPrompt,
    tools: [] as never[],
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
      },
    } as unknown as SharedV3ProviderOptions,
  };
}

/**
 * Find provider-defined tool matching the selected tool name
 */
function findProviderDefinedTool(
  tools: Array<LanguageModelV3FunctionTool | { type: string }>,
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
    tools?: Array<LanguageModelV3FunctionTool | { type: string }>;
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
    (t): t is LanguageModelV3FunctionTool =>
      t.type === "function" &&
      (t as LanguageModelV3FunctionTool).name === selectedToolName
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
        ...(params.toolChoice ? { toolChoice: params.toolChoice } : {}),
      },
    },
  };
}

/**
 * Handle tool choice type 'required'
 */
function handleToolChoiceRequired(
  params: {
    tools?: Array<LanguageModelV3FunctionTool | { type: string }>;
    toolChoice?: { type: string; toolName?: string };
  },
  baseReturnParams: ReturnType<typeof buildBaseReturnParams>,
  functionTools: LanguageModelV3FunctionTool[]
) {
  if (!params.tools || params.tools.length === 0) {
    throw new Error(
      "Tool choice type 'required' is set, but no tools are provided in params.tools."
    );
  }
  if (functionTools.length === 0) {
    throw new Error(
      "Tool choice type 'required' is set, but no function tools are provided. Provider-defined tools are not supported by this middleware."
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
        toolChoice: { type: "required" as const },
      },
    },
  };
}

export function transformParams({
  params,
  protocol,
  toolSystemPromptTemplate,
  toolResponsePromptTemplate,
  placement = "first",
}: {
  params: {
    prompt?: LanguageModelV3Prompt;
    tools?: Array<LanguageModelV3FunctionTool | { type: string }>;
    providerOptions?: {
      toolCallMiddleware?: {
        toolChoice?: { type: string };
      };
    };
    toolChoice?: { type: string; toolName?: string };
  };
  protocol: TCMCoreProtocol | (() => TCMCoreProtocol);
  toolSystemPromptTemplate: (tools: LanguageModelV3FunctionTool[]) => string;
  toolResponsePromptTemplate?: (toolResult: ToolResultPart) => string;
  placement?: "first" | "last";
}) {
  const resolvedProtocol = isTCMProtocolFactory(protocol)
    ? protocol()
    : protocol;

  const functionTools = (params.tools ?? []).filter(
    (t): t is LanguageModelV3FunctionTool => t.type === "function"
  );

  const systemPrompt = resolvedProtocol.formatTools({
    tools: functionTools,
    toolSystemPromptTemplate,
  });

  let normalizedPrompt: LanguageModelV3Message[];
  if (Array.isArray(params.prompt)) {
    normalizedPrompt = params.prompt;
  } else if (params.prompt) {
    normalizedPrompt = [params.prompt];
  } else {
    normalizedPrompt = [];
  }
  const processedPrompt = convertToolPrompt(
    normalizedPrompt,
    resolvedProtocol,
    toolResponsePromptTemplate,
    extractOnErrorOption(params.providerOptions)
  );

  const finalPrompt = buildFinalPrompt(
    systemPrompt,
    processedPrompt,
    placement
  );
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
 * Process a single message in the prompt
 */
function processMessage(
  message: LanguageModelV3Prompt[number],
  resolvedProtocol: TCMCoreProtocol,
  providerOptions?: {
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
  },
  toolResponsePromptTemplate?: (toolResult: ToolResultPart) => string
): LanguageModelV3Prompt[number] {
  if (message.role === "assistant") {
    const condensedContent = assistantToolCallsToTextContent({
      content: message.content as LanguageModelV3Content[],
      protocol: resolvedProtocol,
      conversionOptions: {
        onError: providerOptions?.onError,
      },
    });

    return {
      role: "assistant" as const,
      content: condensedContent as Array<
        | LanguageModelV3TextPart
        | LanguageModelV3FilePart
        | LanguageModelV3ReasoningPart
        | LanguageModelV3ToolCallPart
        | LanguageModelV3ToolResultPart
      >,
    };
  }
  if (message.role === "tool") {
    if (!toolResponsePromptTemplate) {
      throw new Error(
        'toolResponsePromptTemplate is required when processing messages with role "tool". ' +
          "This parameter is optional for other roles but is required here so tool-result content can be " +
          "converted into a prompt. Ensure your middleware or transform configuration passes a toolResponsePromptTemplate " +
          "when tool message processing is enabled."
      );
    }

    return toolRoleContentToUserTextMessage({
      toolContent: message.content as ToolContent,
      toolResponsePromptTemplate,
    });
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
  processedPrompt: LanguageModelV3Prompt
): LanguageModelV3Prompt {
  for (let i = 0; i < processedPrompt.length; i += 1) {
    const msg = processedPrompt[i] as unknown as {
      role: string;
      content: unknown;
    };

    if (!Array.isArray(msg.content)) {
      continue;
    }

    const shouldCondense =
      isAllTextContent(msg.content) && msg.content.length > 1;
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
  processedPrompt: LanguageModelV3Prompt
): LanguageModelV3Prompt {
  for (let i = processedPrompt.length - 1; i > 0; i -= 1) {
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
  prompt: LanguageModelV3Message[],
  resolvedProtocol: TCMCoreProtocol,
  toolResponsePromptTemplate?: (toolResult: ToolResultPart) => string,
  providerOptions?: {
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
  }
): LanguageModelV3Message[] {
  let processedPrompt = prompt.map((message: LanguageModelV3Message) =>
    processMessage(
      message,
      resolvedProtocol,
      providerOptions,
      toolResponsePromptTemplate
    )
  );

  processedPrompt = condenseTextContent(processedPrompt);
  processedPrompt = mergeConsecutiveUserMessages(processedPrompt);
  return processedPrompt as LanguageModelV3Prompt;
}
