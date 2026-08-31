import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import {
  consumeMarkdownCodeText,
  createMarkdownCodeContext,
  markdownCodeContextSuppressesToolCall,
} from "../utils/markdown-code-context";
import { createFlushTextHandler } from "../utils/protocol-utils";

type StreamController =
  TransformStreamDefaultController<LanguageModelV4StreamPart>;

type FlushText = (controller: StreamController, text?: string) => void;

export interface Glm5MarkdownStream {
  beginOversizedFence: (controller: StreamController, raw: string) => void;
  disableBareCallRecovery: () => void;
  finalizeOversizedFence: (controller: StreamController) => boolean;
  flushText: FlushText;
  isBareCallRecoveryEligible: () => boolean;
  isInsideCode: () => boolean;
  resynchronize: (
    controller: StreamController,
    text: string
  ) => { closed: boolean; remainder: string };
}

export function createGlm5MarkdownStream(): Glm5MarkdownStream {
  const context = createMarkdownCodeContext();
  let currentTextId: string | null = null;
  let bareCallRecoveryEligible = true;
  let fenceTail = "";
  let hasEmittedTextStart = false;
  let resynchronizing = false;
  const baseFlushText = createFlushTextHandler(
    () => currentTextId,
    (value) => {
      currentTextId = value;
    },
    () => hasEmittedTextStart,
    (value) => {
      hasEmittedTextStart = value;
    }
  );

  const flushText: FlushText = (controller, text) => {
    if (text) {
      bareCallRecoveryEligible = false;
      consumeMarkdownCodeText(context, text);
    }
    baseFlushText(controller, text);
  };

  const closingFenceText = (delimiterLength: number) => {
    const delimiter = "`".repeat(delimiterLength);
    return fenceTail.endsWith(`\n${delimiter}`) ? `\n${delimiter}` : delimiter;
  };

  const resynchronize = (controller: StreamController, text: string) => {
    if (!resynchronizing) {
      return { closed: true, remainder: text };
    }
    for (let index = 0; index < text.length; index += 1) {
      const { delimiterLength } = context;
      const character = text[index] ?? "";
      consumeMarkdownCodeText(context, character);
      if (delimiterLength > 0 && context.delimiterLength === 0) {
        baseFlushText(controller, closingFenceText(delimiterLength));
        context.trailingBackslashes = 0;
        fenceTail = "";
        resynchronizing = false;
        return { closed: true, remainder: text.slice(index) };
      }
      fenceTail = `${fenceTail}${character}`.slice(-(delimiterLength + 1));
    }
    return { closed: false, remainder: "" };
  };

  const finalizeOversizedFence = (controller: StreamController) => {
    if (!resynchronizing) {
      return false;
    }
    const { delimiterLength } = context;
    markdownCodeContextSuppressesToolCall(context);
    if (delimiterLength > 0 && context.delimiterLength === 0) {
      baseFlushText(controller, closingFenceText(delimiterLength));
    }
    fenceTail = "";
    resynchronizing = false;
    return true;
  };

  return {
    beginOversizedFence(controller, raw) {
      flushText(controller, raw);
      resynchronizing = true;
    },
    disableBareCallRecovery() {
      bareCallRecoveryEligible = false;
    },
    finalizeOversizedFence,
    flushText,
    isBareCallRecoveryEligible: () => bareCallRecoveryEligible,
    isInsideCode: () => markdownCodeContextSuppressesToolCall(context),
    resynchronize,
  };
}
