import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { generateId } from "../utils/id";
import type { TCMProtocol } from "./protocol-interface";

function handleTextDelta(
  chunk: { type: string; textDelta?: string; delta?: string },
  controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
  state: { currentTextId: string | null; hasEmittedText: boolean }
): void {
  const delta = chunk.textDelta ?? chunk.delta;
  if (delta !== undefined && delta !== "") {
    if (!state.currentTextId) {
      state.currentTextId = generateId();
      controller.enqueue({
        type: "text-start",
        id: state.currentTextId,
      });
    }
    controller.enqueue({
      type: "text-delta",
      id: state.currentTextId,
      delta,
    });
    state.hasEmittedText = true;
  }
}

function handleNonTextDelta(
  chunk: LanguageModelV3StreamPart,
  controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
  state: { currentTextId: string | null; hasEmittedText: boolean }
): void {
  if (state.currentTextId && state.hasEmittedText) {
    controller.enqueue({
      type: "text-end",
      id: state.currentTextId,
    });
  }
  state.currentTextId = null;
  state.hasEmittedText = false;
  controller.enqueue(chunk);
}

export const dummyProtocol = (): TCMProtocol => ({
  formatTools: () => "",
  formatToolCall: () => "",
  parseGeneratedText: ({ text }) => [{ type: "text", text }],
  createStreamParser: () => {
    const state = {
      currentTextId: null as string | null,
      hasEmittedText: false,
    };

    return new TransformStream({
      transform(chunk, controller) {
        if (chunk.type === "text-delta") {
          handleTextDelta(
            chunk as { type: string; textDelta?: string; delta?: string },
            controller,
            state
          );
        } else {
          handleNonTextDelta(chunk, controller, state);
        }
      },
    });
  },
});
