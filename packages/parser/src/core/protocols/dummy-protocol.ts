import type { CoreStreamPart } from "../types";
import { generateId } from "../utils/id";
import type { ToolCallProtocol } from "./tool-call-protocol";

function handleTextDelta(
  chunk: { type: string; textDelta?: string; delta?: string },
  controller: TransformStreamDefaultController<CoreStreamPart>,
  state: { currentTextId: string | null; hasEmittedText: boolean }
): void {
  const delta = chunk.textDelta ?? chunk.delta;
  if (delta !== undefined) {
    if (!state.currentTextId) {
      state.currentTextId = generateId();
    }
    controller.enqueue({
      type: "text-delta",
      id: state.currentTextId,
      textDelta: delta,
    });
    state.hasEmittedText = true;
  }
}

function handleNonTextDelta(
  chunk: CoreStreamPart,
  controller: TransformStreamDefaultController<CoreStreamPart>,
  state: { currentTextId: string | null; hasEmittedText: boolean }
): void {
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
        // biome-ignore lint/suspicious/noExplicitAny: complex core stream part mapping
        const c = chunk as any;
        if (c.type === "text-delta") {
          handleTextDelta(c, controller, state);
        } else {
          handleNonTextDelta(c, controller, state);
        }
      },
    });
  },
});
