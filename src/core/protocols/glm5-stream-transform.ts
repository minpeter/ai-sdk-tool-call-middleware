import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";

type StreamController =
  TransformStreamDefaultController<LanguageModelV4StreamPart>;

export function createGlm5StreamTransform({
  finalizePending,
  isPoisoned,
  processTextDelta,
}: {
  finalizePending: (controller: StreamController) => void;
  isPoisoned: () => boolean;
  processTextDelta: (controller: StreamController, delta: string) => void;
}): TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart> {
  return new TransformStream({
    flush(controller) {
      finalizePending(controller);
    },
    transform(part, controller) {
      if (isPoisoned() && part.type !== "error" && part.type !== "finish") {
        return;
      }
      if (part.type === "text-start" || part.type === "text-end") {
        return;
      }
      if (part.type === "text-delta") {
        processTextDelta(controller, part.delta);
        return;
      }
      if (part.type === "finish") {
        finalizePending(controller);
      }
      controller.enqueue(part);
    },
  });
}
