import type { LanguageModelV2FunctionTool } from "@ai-sdk/provider";

type ProviderOptionsWithToolNames = {
  toolCallMiddleware?: {
    toolNames?: string[];
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
    toolChoice?: { type: string };
  };
};

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

export function getFunctionTools(params: {
  tools?: Array<LanguageModelV2FunctionTool | { type: string }>;
  providerOptions?: unknown;
}): LanguageModelV2FunctionTool[] {
  const rawToolNames =
    (params.providerOptions &&
      typeof params.providerOptions === "object" &&
      (params.providerOptions as ProviderOptionsWithToolNames)
        .toolCallMiddleware?.toolNames) ||
    [];
  const toStringArray = (val: unknown): string[] =>
    Array.isArray(val)
      ? (val as unknown[]).filter(
          (item): item is string => typeof item === "string"
        )
      : [];
  const toolNames: string[] = toStringArray(rawToolNames);
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
