import type {
  JSONSchema7,
  LanguageModelV4FunctionTool,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import type { OnErrorFn } from "./on-error";

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

export const originalToolsSchema = {
  encode: encodeOriginalTools,
  decode: decodeOriginalTools,
};

interface EncodedOriginalTool {
  inputSchema: string; // stringified JSONSchema7
  name: string;
}

interface DecodeOriginalToolsOptions {
  onError?: OnErrorFn;
}

export function encodeOriginalTools(
  tools: LanguageModelV4FunctionTool[] | undefined
): Array<{ name: string; inputSchema: string }> {
  return (
    tools?.map((t) => ({
      name: t.name,
      inputSchema: JSON.stringify(t.inputSchema),
    })) || []
  );
}

export function decodeOriginalTools(
  originalTools: EncodedOriginalTool[] | undefined,
  options?: DecodeOriginalToolsOptions
): LanguageModelV4FunctionTool[] {
  if (!originalTools) {
    return [];
  }

  const decodedTools: LanguageModelV4FunctionTool[] = [];

  for (const [index, tool] of originalTools.entries()) {
    if (!tool || typeof tool.name !== "string") {
      options?.onError?.("Invalid originalTools entry: missing tool name", {
        index,
        tool,
      });
      continue;
    }

    if (typeof tool.inputSchema !== "string") {
      options?.onError?.(
        "Invalid originalTools entry: inputSchema must be a string",
        {
          index,
          toolName: tool.name,
        }
      );
      continue;
    }

    try {
      decodedTools.push({
        type: "function",
        name: tool.name,
        inputSchema: JSON.parse(tool.inputSchema) as JSONSchema7,
      });
    } catch (error) {
      options?.onError?.(
        "Failed to decode originalTools input schema, using permissive fallback schema",
        {
          index,
          toolName: tool.name,
          inputSchema: tool.inputSchema,
          error: error instanceof Error ? error.message : String(error),
        }
      );
      decodedTools.push({
        type: "function",
        name: tool.name,
        inputSchema: { type: "object" },
      });
    }
  }

  return decodedTools;
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
