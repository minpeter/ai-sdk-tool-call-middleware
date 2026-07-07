import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { generateId } from "./id";
import { toolCallTextHasPrototypeSensitiveKey } from "./prototype-sensitive-keys";

const REDACTED_SENSITIVE_TOOL_CALL_TEXT = "[redacted sensitive tool call]";

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
