import {
  isJSONValue,
  type JSONObject,
  type JSONValue,
  type LanguageModelV4Content,
  type LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import type { OnErrorFn } from "./on-error";
import {
  REDACTED_SENSITIVE_TOOL_CALL_TEXT,
  safeToolCallMetadataText,
} from "./protocol-utils";
import { toolCallInputHasPrototypeSensitiveKey } from "./prototype-sensitive-keys";
import { coerceToolCallInput } from "./tool-call-coercion";

function isJsonObject(value: JSONValue): value is JSONObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonObjectText(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return isJSONValue(parsed) && isJsonObject(parsed);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return false;
    }
    throw error;
  }
}

/**
 * Select JSON text from forced-tool-choice output. Providers may emit
 * reasoning or empty text before the payload, so every text part is checked.
 */
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
    )?.text ??
    textParts?.find((part) => part.text.trim().length > 0)?.text ??
    textParts?.[0]?.text
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
  expectedToolName?: string;
  onError?: OnErrorFn;
  text?: string;
  tools: LanguageModelV4FunctionTool[];
}

function ensureNonEmptyToolName(name: JSONValue | undefined): string {
  if (typeof name !== "string") {
    return "unknown";
  }
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : "unknown";
}

function safeStringify(value: JSONValue | undefined): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function safeToolChoiceMetadataValue(
  value: JSONValue | undefined
): JSONValue | undefined {
  if (typeof value === "string") {
    return safeToolCallMetadataText(value);
  }
  return toolCallInputHasPrototypeSensitiveKey(value)
    ? REDACTED_SENSITIVE_TOOL_CALL_TEXT
    : value;
}

export function parseToolChoicePayload({
  text,
  tools,
  onError,
  errorMessage,
}: ParseToolChoiceOptions): { toolName: string; input: string } {
  let parsed: JSONValue;
  try {
    const candidate = JSON.parse(text);
    if (!isJSONValue(candidate)) {
      throw new SyntaxError("toolChoice payload is not JSON data");
    }
    parsed = candidate;
  } catch (error) {
    onError?.(errorMessage, {
      text: safeToolCallMetadataText(text),
      error: error instanceof Error ? error.message : String(error),
    });
    return { toolName: "unknown", input: "{}" };
  }

  if (!isJsonObject(parsed)) {
    onError?.("toolChoice JSON payload must be an object", {
      parsedType: typeof parsed,
      parsed: safeToolChoiceMetadataValue(parsed),
    });
    return { toolName: "unknown", input: "{}" };
  }

  const payload = parsed;
  const toolName = ensureNonEmptyToolName(payload.name);
  if (toolCallInputHasPrototypeSensitiveKey(payload)) {
    onError?.("toolChoice payload rejected for sensitive keys", {
      toolName,
      payload: REDACTED_SENSITIVE_TOOL_CALL_TEXT,
    });
    return { toolName, input: "{}" };
  }

  const rawArgs = Object.hasOwn(payload, "arguments") ? payload.arguments : {};

  if (
    rawArgs == null ||
    typeof rawArgs !== "object" ||
    Array.isArray(rawArgs)
  ) {
    onError?.("toolChoice arguments must be a JSON object", {
      toolName,
      arguments: safeToolChoiceMetadataValue(rawArgs),
    });
    return { toolName, input: "{}" };
  }

  if (toolCallInputHasPrototypeSensitiveKey(rawArgs)) {
    onError?.("toolChoice arguments rejected for sensitive keys", {
      toolName,
      arguments: REDACTED_SENSITIVE_TOOL_CALL_TEXT,
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
  expectedToolName,
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
      toolName: expectedToolName ?? "unknown",
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
  if (expectedToolName && parsed.toolName !== expectedToolName) {
    onError?.("toolChoice generation returned an unexpected tool name", {
      expectedToolName,
      toolName: parsed.toolName,
    });
    let originalArguments: JSONValue | undefined;
    try {
      const originalPayload = JSON.parse(text);
      if (
        isJSONValue(originalPayload) &&
        isJsonObject(originalPayload) &&
        Object.hasOwn(originalPayload, "arguments")
      ) {
        originalArguments = originalPayload.arguments;
      }
    } catch {
      originalArguments = undefined;
    }
    parsed.toolName = expectedToolName;
    parsed.input = "{}";
    if (
      originalArguments &&
      typeof originalArguments === "object" &&
      !Array.isArray(originalArguments) &&
      !toolCallInputHasPrototypeSensitiveKey(originalArguments)
    ) {
      parsed.input =
        coerceToolCallInput(expectedToolName, originalArguments, tools) ?? "{}";
    }
  }

  return {
    ...parsed,
    originText: safeToolCallMetadataText(text) ?? "",
  };
}
