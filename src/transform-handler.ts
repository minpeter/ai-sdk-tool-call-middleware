import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FilePart,
  LanguageModelV4FunctionTool,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4ProviderTool,
  LanguageModelV4ReasoningPart,
  LanguageModelV4TextPart,
  LanguageModelV4ToolCallPart,
  LanguageModelV4ToolResultPart,
} from "@ai-sdk/provider";
import type { ToolContent, ToolResultPart } from "@ai-sdk/provider-utils";
import { assistantToolCallsToTextContent } from "./core/prompts/shared/assistant-tool-calls-to-text";
import {
  type ToolResponsePromptTemplateResult,
  toolRoleContentToUserTextMessage,
} from "./core/prompts/shared/tool-role-to-user-message";
import type {
  ParserOptions,
  TCMCoreProtocol,
} from "./core/protocols/protocol-interface";
import { isProtocolFactory } from "./core/protocols/protocol-interface";
import { createDynamicIfThenElseSchema } from "./core/utils/dynamic-tool-schema";
import { extractOnErrorOption } from "./core/utils/on-error";
import {
  mergeToolCallMiddlewareOptions,
  originalToolsSchema,
  type ToolCallMiddlewareProviderOptions,
} from "./core/utils/provider-options";
import type { ToolInputSchema } from "./schema/tool-input-schema";

/**
 * Controls how historical assistant tool calls and tool results are encoded.
 * `provider-native` preserves the original AI SDK assistant and tool messages.
 */
export type ToolCallHistoryMode = "converted-text" | "provider-native";

/**
 * Controls where the rendered tool system prompt is inserted.
 * `standalone-first` prepends a new system turn without merging existing turns.
 */
export type ToolSystemPromptPlacement = "first" | "last" | "standalone-first";

export interface ToolCallTransformSettings {
  readonly historyMode?: ToolCallHistoryMode;
  readonly placement?: ToolSystemPromptPlacement;
  readonly protocol: TCMCoreProtocol | (() => TCMCoreProtocol);
  /**
   * Omit the protocol-specific tool catalog when `toolChoice` is `required` or
   * selects a fixed tool. The forced-choice handlers request JSON through
   * `responseFormat`, so protocols that instruct a different output grammar
   * can opt out of issuing contradictory system instructions.
   */
  readonly suppressToolSystemPromptForForcedChoice?: boolean;
  readonly toolResponsePromptTemplate?: (
    toolResult: ToolResultPart
  ) => ToolResponsePromptTemplateResult;
  readonly toolSystemPromptTemplate: (
    tools: LanguageModelV4FunctionTool[]
  ) => string;
}

type TransformCallOptions = Omit<
  LanguageModelV4CallOptions,
  "providerOptions"
> & {
  providerOptions?: LanguageModelV4CallOptions["providerOptions"] &
    ToolCallMiddlewareProviderOptions;
};

/**
 * Build the final prompt by placing or merging the rendered system prompt.
 */
function buildFinalPrompt(
  systemPrompt: string,
  processedPrompt: LanguageModelV4Prompt,
  placement: ToolSystemPromptPlacement
): LanguageModelV4Prompt {
  if (systemPrompt.trim().length === 0) {
    return processedPrompt;
  }

  if (placement === "standalone-first") {
    return [
      {
        role: "system",
        content: systemPrompt,
      },
      ...processedPrompt,
    ];
  }

  const systemIndex = processedPrompt.findIndex((m) => m.role === "system");
  if (systemIndex !== -1) {
    const existingMessage = processedPrompt[systemIndex];
    const existingText =
      existingMessage?.role === "system" ? existingMessage.content : "";

    const mergedContent =
      placement === "first"
        ? `${systemPrompt}\n\n${existingText}`
        : `${existingText}\n\n${systemPrompt}`;

    return processedPrompt.map((message, index) =>
      index === systemIndex && message.role === "system"
        ? {
            ...message,
            content: mergedContent,
          }
        : message
    );
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
  params: TransformCallOptions,
  finalPrompt: LanguageModelV4Prompt,
  functionTools: LanguageModelV4FunctionTool[]
): LanguageModelV4CallOptions {
  const droppedProviderTools = (params.tools ?? [])
    .filter((tool) => tool.type === "provider")
    .map((tool) => tool.name);

  return {
    ...params,
    prompt: finalPrompt,
    tools: [],
    toolChoice: undefined,
    providerOptions: mergeToolCallMiddlewareOptions(params.providerOptions, {
      originalTools: originalToolsSchema.encode(functionTools),
      ...(droppedProviderTools.length > 0 ? { droppedProviderTools } : {}),
    }),
  };
}

/**
 * Find provider-defined tool matching the selected tool name
 */
function findProviderDefinedTool(
  tools: Array<LanguageModelV4FunctionTool | LanguageModelV4ProviderTool>,
  selectedToolName: string
) {
  return tools.find(
    (tool) =>
      tool.type === "provider" &&
      (tool.id === selectedToolName || tool.name === selectedToolName)
  );
}

/**
 * Handle tool choice type 'tool'
 */
function handleToolChoiceTool(
  params: TransformCallOptions,
  baseReturnParams: LanguageModelV4CallOptions
): LanguageModelV4CallOptions {
  const selectedToolName =
    params.toolChoice?.type === "tool" ? params.toolChoice.toolName : undefined;
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
    (t): t is LanguageModelV4FunctionTool =>
      t.type === "function" && t.name === selectedToolName
  );

  if (!selectedTool) {
    throw new Error(
      `Tool with name '${selectedToolName}' not found in params.tools.`
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
      } satisfies ToolInputSchema,
      name: selectedTool.name,
      description:
        typeof selectedTool.description === "string"
          ? selectedTool.description
          : undefined,
    },
    providerOptions: mergeToolCallMiddlewareOptions(
      baseReturnParams.providerOptions,
      params.toolChoice ? { toolChoice: params.toolChoice } : {}
    ),
  };
}

/**
 * Handle tool choice type 'required'
 */
function handleToolChoiceRequired(
  params: TransformCallOptions,
  baseReturnParams: LanguageModelV4CallOptions,
  functionTools: LanguageModelV4FunctionTool[]
): LanguageModelV4CallOptions {
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
      type: "json",
      schema: createDynamicIfThenElseSchema(functionTools),
    },
    providerOptions: mergeToolCallMiddlewareOptions(
      baseReturnParams.providerOptions,
      {
        toolChoice: { type: "required" },
      }
    ),
  };
}

export function transformParams({
  params,
  protocol,
  toolSystemPromptTemplate,
  toolResponsePromptTemplate,
  placement = "first",
  historyMode = "converted-text",
  suppressToolSystemPromptForForcedChoice = false,
}: ToolCallTransformSettings & { readonly params: TransformCallOptions }) {
  const resolvedProtocol = isProtocolFactory(protocol) ? protocol() : protocol;

  const functionTools = (params.tools ?? []).filter(
    (t): t is LanguageModelV4FunctionTool => t.type === "function"
  );

  const forcedToolChoice =
    params.toolChoice?.type === "tool" ||
    params.toolChoice?.type === "required";
  const systemPrompt =
    suppressToolSystemPromptForForcedChoice && forcedToolChoice
      ? ""
      : resolvedProtocol.formatTools({
          tools: functionTools,
          toolSystemPromptTemplate,
        });

  const normalizedPrompt = params.prompt;
  const processedPrompt =
    historyMode === "provider-native"
      ? normalizedPrompt
      : convertToolPrompt(
          normalizedPrompt,
          resolvedProtocol,
          toolResponsePromptTemplate,
          extractOnErrorOption(params.providerOptions)
        );

  if (params.toolChoice?.type === "none") {
    // 'none' means the model must not call tools on this step. Tool-call
    // history retains its selected representation, but no tool definitions
    // are injected and the wrap handlers skip tool-call parsing entirely.
    return {
      ...params,
      prompt: processedPrompt,
      tools: [],
      toolChoice: undefined,
      providerOptions: mergeToolCallMiddlewareOptions(params.providerOptions, {
        toolChoice: { type: "none" },
      }),
    };
  }

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
  message: LanguageModelV4Prompt[number],
  resolvedProtocol: TCMCoreProtocol,
  providerOptions?: Pick<ParserOptions, "onError">,
  toolResponsePromptTemplate?: (
    toolResult: ToolResultPart
  ) => ToolResponsePromptTemplateResult
): LanguageModelV4Prompt[number] {
  if (message.role === "assistant") {
    const condensedContent = assistantToolCallsToTextContent({
      content: message.content as LanguageModelV4Content[],
      protocol: resolvedProtocol,
      conversionOptions: {
        onError: providerOptions?.onError,
      },
    });

    return {
      role: "assistant",
      content: condensedContent as Array<
        | LanguageModelV4TextPart
        | LanguageModelV4FilePart
        | LanguageModelV4ReasoningPart
        | LanguageModelV4ToolCallPart
        | LanguageModelV4ToolResultPart
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
function isAllTextContent(
  content: LanguageModelV4Message["content"]
): content is LanguageModelV4TextPart[] {
  return (
    Array.isArray(content) && content.every((part) => part.type === "text")
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
function createCondensedMessage(
  role: "assistant" | "system" | "user",
  joinedText: string
): LanguageModelV4Message {
  if (role === "system") {
    return {
      role: "system",
      content: joinedText,
    };
  }

  return {
    role,
    content: [
      {
        type: "text",
        text: joinedText,
      },
    ],
  };
}

/**
 * Condense multi-part text content into single text part
 */
function condenseTextContent(
  processedPrompt: LanguageModelV4Prompt
): LanguageModelV4Prompt {
  for (let i = 0; i < processedPrompt.length; i += 1) {
    const message = processedPrompt[i];
    if (
      !message ||
      message.role === "system" ||
      message.role === "tool" ||
      !isAllTextContent(message.content) ||
      message.content.length <= 1
    ) {
      continue;
    }

    const joinedText = joinTextContent(message.content);
    processedPrompt[i] = createCondensedMessage(message.role, joinedText);
  }
  return processedPrompt;
}

/**
 * Merge consecutive user messages
 */
function mergeConsecutiveUserMessages(
  processedPrompt: LanguageModelV4Prompt
): LanguageModelV4Prompt {
  for (let i = processedPrompt.length - 1; i > 0; i -= 1) {
    const current = processedPrompt[i];
    const prev = processedPrompt[i - 1];
    if (current.role === "user" && prev.role === "user") {
      if (
        !(isAllTextContent(prev.content) && isAllTextContent(current.content))
      ) {
        continue;
      }

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
  prompt: LanguageModelV4Message[],
  resolvedProtocol: TCMCoreProtocol,
  toolResponsePromptTemplate?: (
    toolResult: ToolResultPart
  ) => ToolResponsePromptTemplateResult,
  providerOptions?: Pick<ParserOptions, "onError">
): LanguageModelV4Message[] {
  let processedPrompt = prompt.map((message: LanguageModelV4Message) =>
    processMessage(
      message,
      resolvedProtocol,
      providerOptions,
      toolResponsePromptTemplate
    )
  );

  processedPrompt = condenseTextContent(processedPrompt);
  processedPrompt = mergeConsecutiveUserMessages(processedPrompt);
  return processedPrompt;
}
