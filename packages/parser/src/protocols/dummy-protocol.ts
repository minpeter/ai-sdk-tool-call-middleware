import { generateId } from "@ai-sdk/provider-utils";

import type { ToolCallProtocol } from "./tool-call-protocol";

export const dummyProtocol = (): ToolCallProtocol => ({
  formatTools: () => "",
  formatToolCall: () => "",
  formatToolResponse: () => "",
  parseGeneratedText: ({ text }) => [{ type: "text", text }],
  createStreamParser: () => {
    let currentTextId: string | null = null;
    let hasEmittedText = false;

    return new TransformStream({
      transform(chunk, controller) {
        if (chunk.type === "text-delta") {
          if (chunk.delta) {
            if (!currentTextId) {
              currentTextId = generateId();
              controller.enqueue({ type: "text-start", id: currentTextId });
            }
            controller.enqueue({ ...chunk, id: currentTextId });
            hasEmittedText = true;
          }
        } else {
          if (currentTextId && hasEmittedText) {
            controller.enqueue({ type: "text-end", id: currentTextId });
          }
          currentTextId = null;
          hasEmittedText = false;
          controller.enqueue(chunk);
        }
      },
      flush(controller) {
        if (currentTextId && hasEmittedText) {
          controller.enqueue({ type: "text-end", id: currentTextId });
        }
      },
    });
  },
});
