import type {
  JSONSchema7,
  LanguageModelV2FunctionTool,
} from "@ai-sdk/provider";

export type ToolCallMiddlewareProviderOptions = {
  toolCallMiddleware?: {
    // onError?: (message: string, metadata?: Record<string, unknown>) => void;
    // Optional debug summary container that middleware can populate.
    // Values must be JSON-safe.
    debugSummary?: {
      originalText?: string;
      toolCalls?: string; // JSON string of array of { toolName, input }
    };

    // INTERNAL: Set by transform-handler. Used for internal propagation of tool-choice.
    toolChoice?: { type: string };
    // INTERNAL: Set by transform-handler. Used for internal propagation of params.tools.
    originalTools?: Array<{
      name: string;
      inputSchema: string; // Stringified JSONSchema7
    }>;
  };
};

export const originalToolsSchema = {
  encode: encodeOriginalTools,
  decode: decodeOriginalTools,
};

export function encodeOriginalTools(
  tools: LanguageModelV2FunctionTool[] | undefined
): Array<{ name: string; inputSchema: string }> {
  return (
    tools?.map((t) => ({
      name: t.name,
      inputSchema: JSON.stringify(t.inputSchema),
    })) || []
  );
}

export function decodeOriginalTools(
  originalTools:
    | Array<{
        name: string;
        inputSchema: string; // stringified JSONSchema7
      }>
    | undefined
): LanguageModelV2FunctionTool[] {
  const tools =
    originalTools?.map(
      (t) =>
        ({
          name: t.name,
          inputSchema: JSON.parse(t.inputSchema) as JSONSchema7,
        }) as LanguageModelV2FunctionTool
    ) || [];

  return tools;
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
