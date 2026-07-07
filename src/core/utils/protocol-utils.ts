import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { generateId } from "./id";
import {
  toolCallInputHasPrototypeSensitiveKey,
  toolCallTextHasPrototypeSensitiveKey,
} from "./prototype-sensitive-keys";

export const REDACTED_SENSITIVE_TOOL_CALL_TEXT =
  "[redacted sensitive tool call]";
const PROTOTYPE_SENSITIVE_ERROR_DETAIL_REGEX =
  /\b(?:__proto__|constructor|prototype)\b|prototype-sensitive/i;

export function formatToolsWithPromptTemplate(options: {
  tools: LanguageModelV4FunctionTool[];
  toolSystemPromptTemplate: (tools: LanguageModelV4FunctionTool[]) => string;
}): string {
  return options.toolSystemPromptTemplate(options.tools || []);
}

export function extractToolNames(
  tools: LanguageModelV4FunctionTool[]
): string[] {
  return tools.map((tool) => tool.name).filter(Boolean) as string[];
}

export function addTextSegment(
  text: string,
  processedElements: LanguageModelV4Content[]
): void {
  if (text.trim()) {
    processedElements.push({ type: "text", text });
  }
}

export function safeToolCallMetadataText(
  text: string | null | undefined
): string | null | undefined {
  if (typeof text !== "string") {
    return text;
  }
  return toolCallTextHasPrototypeSensitiveKey(text)
    ? REDACTED_SENSITIVE_TOOL_CALL_TEXT
    : text;
}

function errorCause(error: Error): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(error, "cause");
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function errorHasPrototypeSensitiveDetails(error: Error): boolean {
  if (
    PROTOTYPE_SENSITIVE_ERROR_DETAIL_REGEX.test(error.message) ||
    toolCallTextHasPrototypeSensitiveKey(error.message)
  ) {
    return true;
  }
  if (
    typeof error.stack === "string" &&
    (PROTOTYPE_SENSITIVE_ERROR_DETAIL_REGEX.test(error.stack) ||
      toolCallTextHasPrototypeSensitiveKey(error.stack))
  ) {
    return true;
  }
  const cause = errorCause(error);
  if (typeof cause === "string") {
    return (
      PROTOTYPE_SENSITIVE_ERROR_DETAIL_REGEX.test(cause) ||
      toolCallTextHasPrototypeSensitiveKey(cause)
    );
  }
  if (cause instanceof Error) {
    return errorHasPrototypeSensitiveDetails(cause);
  }
  return cause != null && toolCallInputHasPrototypeSensitiveKey(cause);
}

export function safeToolCallMetadataValue(value: unknown): unknown {
  if (typeof value === "string") {
    return toolCallInputHasPrototypeSensitiveKey(value)
      ? REDACTED_SENSITIVE_TOOL_CALL_TEXT
      : value;
  }
  if (value instanceof Error) {
    return errorHasPrototypeSensitiveDetails(value)
      ? REDACTED_SENSITIVE_TOOL_CALL_TEXT
      : value;
  }
  return toolCallInputHasPrototypeSensitiveKey(value)
    ? REDACTED_SENSITIVE_TOOL_CALL_TEXT
    : value;
}

export function safeToolCallMetadataError(
  error: unknown,
  sourceText?: string | null
): unknown {
  if (
    typeof sourceText === "string" &&
    toolCallTextHasPrototypeSensitiveKey(sourceText)
  ) {
    return REDACTED_SENSITIVE_TOOL_CALL_TEXT;
  }
  return safeToolCallMetadataValue(error);
}

export function createFlushTextHandler(
  getCurrentTextId: () => string | null,
  setCurrentTextId: (id: string | null) => void,
  getHasEmittedTextStart: () => boolean,
  setHasEmittedTextStart: (value: boolean) => void
) {
  return (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
    text?: string
  ) => {
    const content = text;
    if (content) {
      if (!getCurrentTextId()) {
        const newId = generateId();
        setCurrentTextId(newId);
        controller.enqueue({
          type: "text-start",
          id: newId,
        });
        setHasEmittedTextStart(true);
      }
      controller.enqueue({
        type: "text-delta",
        id: getCurrentTextId() as string,
        delta: content,
      });
    }

    const currentTextId = getCurrentTextId();
    if (currentTextId && !text) {
      if (getHasEmittedTextStart()) {
        controller.enqueue({
          type: "text-end",
          id: currentTextId,
        });
        setHasEmittedTextStart(false);
      }
      setCurrentTextId(null);
    }
  };
}
