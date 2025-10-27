import { generateId } from "@ai-sdk/provider-utils";

import type { ToolCallProtocol } from "./tool-call-protocol";

function handleTextDelta(
  chunk: { type: string; delta?: string },
  controller: TransformStreamDefaultController,
  state: { currentTextId: string | null; hasEmittedText: boolean }
): void {
  if (chunk.delta) {
    if (!state.currentTextId) {
      state.currentTextId = generateId();
      controller.enqueue({ type: "text-start", id: state.currentTextId });
    }
    controller.enqueue({ ...chunk, id: state.currentTextId });
    state.hasEmittedText = true;
  }
}

function handleNonTextDelta(
  chunk: unknown,
  controller: TransformStreamDefaultController,
  state: { currentTextId: string | null; hasEmittedText: boolean }
): void {
  if (state.currentTextId && state.hasEmittedText) {
    controller.enqueue({ type: "text-end", id: state.currentTextId });
  }
  state.currentTextId = null;
  state.hasEmittedText = false;
  controller.enqueue(chunk);
}

export const dummyProtocol = (): ToolCallProtocol => ({
  formatTools: () => "",
  formatToolCall: () => "",
  formatToolResponse: () => "",
  parseGeneratedText: ({ text }) => [{ type: "text", text }],
  createStreamParser: () => {
    const state = {
      currentTextId: null as string | null,
      hasEmittedText: false,
    };

    return new TransformStream({
      transform(chunk, controller) {
        if (chunk.type === "text-delta") {
          handleTextDelta(chunk, controller, state);
        } else {
          handleNonTextDelta(chunk, controller, state);
        }
      },
      flush(controller) {
        if (state.currentTextId && state.hasEmittedText) {
          controller.enqueue({ type: "text-end", id: state.currentTextId });
        }
      },
    });
  },
});
