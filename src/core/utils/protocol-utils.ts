import type {
  LanguageModelV3Content,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { generateId } from "./id";

export function addTextSegment(
  text: string,
  processedElements: LanguageModelV3Content[]
): void {
  if (text.trim()) {
    processedElements.push({ type: "text", text });
  }
}

export function createFlushTextHandler(
  getCurrentTextId: () => string | null,
  setCurrentTextId: (id: string | null) => void,
  getHasEmittedTextStart: () => boolean,
  setHasEmittedTextStart: (value: boolean) => void
) {
  return (
    controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
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
