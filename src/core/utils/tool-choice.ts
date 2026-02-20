import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import type { OnErrorFn } from "./on-error";
import { coerceToolCallInput } from "./tool-call-coercion";

interface ParseToolChoiceOptions {
  errorMessage: string;
  onError?: OnErrorFn;
  text: string;
  tools: LanguageModelV3FunctionTool[];
}

interface ResolveToolChoiceSelectionOptions {
  errorMessage: string;
  onError?: OnErrorFn;
  text?: string;
  tools: LanguageModelV3FunctionTool[];
}

function ensureNonEmptyToolName(name: unknown): string {
  if (typeof name !== "string") {
    return "unknown";
  }
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : "unknown";
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

export function parseToolChoicePayload({
  text,
  tools,
  onError,
  errorMessage,
}: ParseToolChoiceOptions): { toolName: string; input: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    onError?.(errorMessage, {
      text,
      error: error instanceof Error ? error.message : String(error),
    });
    return { toolName: "unknown", input: "{}" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    onError?.("toolChoice JSON payload must be an object", {
      parsedType: typeof parsed,
      parsed,
    });
    return { toolName: "unknown", input: "{}" };
  }

  const payload = parsed as Record<string, unknown>;
  const toolName = ensureNonEmptyToolName(payload.name);
  const rawArgs = Object.hasOwn(payload, "arguments") ? payload.arguments : {};

  if (
    rawArgs == null ||
    typeof rawArgs !== "object" ||
    Array.isArray(rawArgs)
  ) {
    onError?.("toolChoice arguments must be a JSON object", {
      toolName,
      arguments: rawArgs,
    });
    return { toolName, input: "{}" };
  }

  const coercedInput = coerceToolCallInput(toolName, rawArgs, tools);

  return {
    toolName,
    input: coercedInput ?? safeStringify(rawArgs),
  };
}

export function resolveToolChoiceSelection({
  text,
  tools,
  onError,
  errorMessage,
}: ResolveToolChoiceSelectionOptions): {
  input: string;
  originText: string;
  toolName: string;
} {
  if (typeof text !== "string") {
    return {
      toolName: "unknown",
      input: "{}",
      originText: "",
    };
  }

  const parsed = parseToolChoicePayload({
    text,
    tools,
    onError,
    errorMessage,
  });

  return {
    ...parsed,
    originText: text,
  };
}
