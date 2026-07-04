import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import type { OnErrorFn } from "./on-error";
import { coerceToolCallInput } from "./tool-call-coercion";

/**
 * First text content part of a forced-tool-choice generation. Providers may
 * emit reasoning (or other) parts before the JSON text even under
 * `responseFormat: json`, so the whole content array is scanned instead of
 * only inspecting `content[0]`.
 */
export function findFirstNonEmptyTextContent(
  content: LanguageModelV4Content[] | undefined
): string | undefined {
  const textParts = content?.filter(
    (item): item is Extract<LanguageModelV4Content, { type: "text" }> =>
      item.type === "text"
  );
  return (
    textParts?.find((part) => part.text.trim().length > 0)?.text ??
    textParts?.[0]?.text
  );
}

function isJsonObjectText(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return Boolean(
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
    );
  } catch {
    return false;
  }
}

export function findToolChoiceTextContent(
  content: LanguageModelV4Content[] | undefined
): string | undefined {
  const textParts = content?.filter(
    (item): item is Extract<LanguageModelV4Content, { type: "text" }> =>
      item.type === "text"
  );
  return (
    textParts?.find(
      (part) => part.text.trim().length > 0 && isJsonObjectText(part.text)
    )?.text ?? findFirstNonEmptyTextContent(content)
  );
}

interface ParseToolChoiceOptions {
  errorMessage: string;
  onError?: OnErrorFn;
  text: string;
  tools: LanguageModelV4FunctionTool[];
}

interface ResolveToolChoiceSelectionOptions {
  errorMessage: string;
  onError?: OnErrorFn;
  text?: string;
  tools: LanguageModelV4FunctionTool[];
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
    onError?.(
      "toolChoice generation returned no text content to parse; emitting fallback tool call",
      { errorMessage }
    );
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
