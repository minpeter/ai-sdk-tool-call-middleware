import type {
  LanguageModelV4FunctionTool,
  SharedV4ProviderOptions,
  SharedV4Warning,
} from "@ai-sdk/provider";
import {
  type DecodeOriginalToolsOptions,
  decodeOriginalTools as decodeOriginalToolsImpl,
  type EncodedOriginalTool,
  encodeOriginalTools as encodeOriginalToolsImpl,
  lookupCachedDecodedOriginalTools,
} from "./transport/original-tools-cache";

export interface ToolCallMiddlewareProviderOptions {
  toolCallMiddleware?: {
    // onError?: (message: string, metadata?: Record<string, unknown>) => void;
    // Optional debug summary container that middleware can populate.
    // Values must be JSON-safe.
    debugSummary?: {
      originalText?: string;
      toolCalls?: string; // JSON string of array of { toolName, input }
    };

    // INTERNAL: Set by transform-handler. Used for internal propagation of tool-choice.
    toolChoice?: { type: string; toolName?: string };
    // INTERNAL: Set by transform-handler. Used for internal propagation of params.tools.
    originalTools?: Array<{
      name: string;
      inputSchema: string; // Stringified JSONSchema7
    }>;
    // INTERNAL: Set by transform-handler. Names of provider tools that were
    // dropped because prompt-based tool calling only supports function tools.
    droppedProviderTools?: string[];
  };
}

/**
 * Names of provider tools dropped by transformParams, so the wrap handlers
 * can surface a spec warning instead of discarding them silently.
 */
export function getDroppedProviderTools(providerOptions: unknown): string[] {
  const middlewareOptions = getToolCallMiddlewareOptions(providerOptions);
  const dropped = (middlewareOptions as { droppedProviderTools?: unknown })
    .droppedProviderTools;
  if (!Array.isArray(dropped)) {
    return [];
  }
  return dropped.filter((name): name is string => typeof name === "string");
}

/**
 * Prompt-based tool calling can only express function tools; provider tools
 * are dropped in transformParams and surfaced as spec warnings by wrap handlers.
 */
export function createDroppedProviderToolWarnings(
  providerOptions: unknown
): SharedV4Warning[] {
  return getDroppedProviderTools(providerOptions).map(
    (name): SharedV4Warning => ({
      type: "unsupported",
      feature: `provider tool ${name}`,
      details:
        "Prompt-based tool-call middleware only supports function tools; the provider tool was removed from the request.",
    })
  );
}

export function getToolChoiceExpectedToolName(
  providerOptions: unknown
): string | undefined {
  const toolChoice = getToolCallMiddlewareOptions(providerOptions).toolChoice as
    | { toolName?: unknown }
    | undefined;
  return typeof toolChoice?.toolName === "string"
    ? toolChoice.toolName
    : undefined;
}

export function encodeOriginalTools(
  tools: LanguageModelV4FunctionTool[] | undefined
): Array<{ name: string; inputSchema: string }> {
  return encodeOriginalToolsImpl(tools);
}

export function decodeOriginalTools(
  originalTools: EncodedOriginalTool[] | undefined,
  options?: DecodeOriginalToolsOptions
): LanguageModelV4FunctionTool[] {
  return decodeOriginalToolsImpl(originalTools, options);
}

export const originalToolsSchema = {
  encode: encodeOriginalTools,
  decode: decodeOriginalTools,
};

export function decodeOriginalToolsForMiddleware(
  providerOptions: ToolCallMiddlewareProviderOptions | undefined,
  options?: DecodeOriginalToolsOptions
): LanguageModelV4FunctionTool[] {
  return lookupCachedDecodedOriginalTools(
    providerOptions?.toolCallMiddleware?.originalTools,
    options
  );
}

export function decodeOriginalToolsFromProviderOptions(
  providerOptions: ToolCallMiddlewareProviderOptions | undefined,
  options?: DecodeOriginalToolsOptions
): LanguageModelV4FunctionTool[] {
  return decodeOriginalTools(
    providerOptions?.toolCallMiddleware?.originalTools,
    options
  );
}

export function extractToolNamesFromOriginalTools(
  originalTools:
    | Array<{
        name: string;
        inputSchema: string; // stringified JSONSchema7
      }>
    | undefined
): string[] {
  return originalTools?.map((t) => t.name) || [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getToolCallMiddlewareOptions(
  providerOptions?: unknown
): Record<string, unknown> {
  if (!isRecord(providerOptions)) {
    return {};
  }

  const { toolCallMiddleware } = providerOptions;
  if (!isRecord(toolCallMiddleware)) {
    return {};
  }

  return toolCallMiddleware;
}

export function mergeToolCallMiddlewareOptions(
  providerOptions: unknown,
  overrides: Record<string, unknown>
): SharedV4ProviderOptions {
  return {
    ...(isRecord(providerOptions) ? providerOptions : {}),
    toolCallMiddleware: {
      ...getToolCallMiddlewareOptions(providerOptions),
      ...overrides,
    },
  } as SharedV4ProviderOptions;
}

export function isToolChoiceActive(params: {
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

export function isToolChoiceNone(params: {
  providerOptions?: {
    toolCallMiddleware?: {
      toolChoice?: { type: string };
    };
  };
}): boolean {
  return (
    params.providerOptions?.toolCallMiddleware?.toolChoice?.type === "none"
  );
}
