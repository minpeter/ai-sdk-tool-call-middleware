import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { recoverToolCallFromJsonCandidates } from "./generated-text-json-recovery";
import { generateId } from "./id";

/**
 * Maximum number of characters held back while a text block is still a
 * plausible bare-JSON tool call. Mirrors the candidate size cap used by the
 * non-streaming recovery scan.
 */
const MAX_HELD_BLOCK_LENGTH = 10_000;

type StreamController =
  TransformStreamDefaultController<LanguageModelV4StreamPart>;

interface HeldTextBlock {
  content: string;
  id: string;
  startPart: LanguageModelV4StreamPart;
}

/**
 * Streaming counterpart of `recoverToolCallFromJsonCandidates`: some models
 * emit a bare `{"name": ..., "arguments": ...}` payload without any protocol
 * markup. The generate path recovers those from the final text; without this
 * stage the stream path would leak the JSON as visible text.
 *
 * A text block whose first non-whitespace character is `{` is held back until
 * the block ends (or the stream finishes). If the accumulated block resolves
 * to a known tool call it is re-emitted as a full tool-input/tool-call
 * lifecycle; otherwise the block is flushed as ordinary text. Blocks that
 * start with anything else stream through untouched, so regular prose keeps
 * its incremental delivery.
 */
export function createStreamJsonRecoveryTransform({
  tools,
}: {
  tools: LanguageModelV4FunctionTool[];
}): TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart> {
  if (tools.length === 0) {
    return new TransformStream<
      LanguageModelV4StreamPart,
      LanguageModelV4StreamPart
    >();
  }

  let disabled = false;
  let held: HeldTextBlock | null = null;

  const flushHeld = (controller: StreamController, closeBlock: boolean) => {
    if (!held) {
      return;
    }
    controller.enqueue(held.startPart);
    if (held.content.length > 0) {
      controller.enqueue({
        type: "text-delta",
        id: held.id,
        delta: held.content,
      });
    }
    if (closeBlock) {
      controller.enqueue({ type: "text-end", id: held.id });
    }
    held = null;
  };

  const emitRecoveredParts = (
    controller: StreamController,
    recovered: ReturnType<typeof recoverToolCallFromJsonCandidates>
  ) => {
    for (const part of recovered ?? []) {
      if (part.type === "text") {
        if (part.text.length === 0) {
          continue;
        }
        const textId = generateId();
        controller.enqueue({ type: "text-start", id: textId });
        controller.enqueue({
          type: "text-delta",
          id: textId,
          delta: part.text,
        });
        controller.enqueue({ type: "text-end", id: textId });
        continue;
      }
      if (part.type === "tool-call") {
        controller.enqueue({
          type: "tool-input-start",
          id: part.toolCallId,
          toolName: part.toolName,
        });
        if (part.input.length > 0) {
          controller.enqueue({
            type: "tool-input-delta",
            id: part.toolCallId,
            delta: part.input,
          });
        }
        controller.enqueue({ type: "tool-input-end", id: part.toolCallId });
        controller.enqueue(part);
      }
    }
  };

  const resolveHeld = (controller: StreamController, closeBlock: boolean) => {
    if (!held) {
      return;
    }
    const recovered = recoverToolCallFromJsonCandidates(held.content, tools);
    const hasToolCall = recovered?.some((part) => part.type === "tool-call");
    if (recovered && hasToolCall) {
      held = null;
      emitRecoveredParts(controller, recovered);
      disabled = true;
      return;
    }
    flushHeld(controller, closeBlock);
  };

  const heldBlockStillViable = (content: string): boolean => {
    if (content.length > MAX_HELD_BLOCK_LENGTH) {
      return false;
    }
    // A block can still resolve to a tool call when it starts with a bare
    // JSON object or a fenced code block (```json ... ```), mirroring the
    // candidate shapes of the non-streaming recovery scan.
    const leading = content.trimStart();
    if (leading.length === 0 || leading.startsWith("{")) {
      return true;
    }
    const fencePrefix = leading.slice(0, 3);
    return "```".startsWith(fencePrefix);
  };

  return new TransformStream<
    LanguageModelV4StreamPart,
    LanguageModelV4StreamPart
  >({
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Stream part routing needs one branch per part type interacting with the held block.
    transform(part, controller) {
      if (disabled) {
        controller.enqueue(part);
        return;
      }

      if (part.type === "tool-call") {
        // The protocol parser already found a real tool call; recovery is a
        // fallback for streams where it found none.
        flushHeld(controller, false);
        disabled = true;
        controller.enqueue(part);
        return;
      }

      if (part.type === "text-start") {
        flushHeld(controller, false);
        held = { startPart: part, id: part.id, content: "" };
        return;
      }

      if (part.type === "text-delta" && held && part.id === held.id) {
        held.content += part.delta;
        if (!heldBlockStillViable(held.content)) {
          flushHeld(controller, false);
        }
        return;
      }

      if (part.type === "text-end") {
        if (held && part.id === held.id) {
          resolveHeld(controller, true);
          return;
        }
        // A text-end for a block that already streamed through (protocol
        // parsers re-identify published text, so the provider's original
        // block close can arrive while a re-identified block is held).
        // Forward it without disturbing the held block.
        controller.enqueue(part);
        return;
      }

      if (part.type === "finish") {
        resolveHeld(controller, true);
        controller.enqueue(part);
        return;
      }

      if (held) {
        flushHeld(controller, false);
      }
      controller.enqueue(part);
    },

    flush(controller) {
      // Defensive: a stream that ends without a finish part still must not
      // swallow held text.
      resolveHeld(controller, true);
    },
  });
}
