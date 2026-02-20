import type {
  JSONSchema7,
  LanguageModelV3FunctionTool,
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
  };
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
  tools: LanguageModelV3FunctionTool[] | undefined
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
): LanguageModelV3FunctionTool[] {
  if (!originalTools) {
    return [];
  }

  const decodedTools: LanguageModelV3FunctionTool[] = [];

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
