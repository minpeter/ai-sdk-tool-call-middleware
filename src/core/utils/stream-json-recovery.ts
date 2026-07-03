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

/**
 * Fenced blocks are held only for info strings the non-streaming recovery
 * scan actually parses (```json / ```yaml / ```xml or none). A ```python
 * block can never resolve to a tool call, so it streams through.
 */
const RECOVERABLE_FENCE_REGEX = /^```(?:json|ya?ml|xml)?\s*(?:\n|$)/i;
const FENCE_PREFIX = "```";
const RECOVERABLE_TOOL_CALL_TAG = "<tool_call>";
const RECOVERABLE_QWEN_CALL_TAGS = ["call", "function", "tool", "invoke"];
const ASCII_WHITESPACE_REGEX = /\s/;

type StreamController =
  TransformStreamDefaultController<LanguageModelV4StreamPart>;

interface HeldTextBlock {
  content: string;
  id: string;
  startPart: LanguageModelV4StreamPart;
}

function fenceStillViable(leading: string): boolean {
  if (leading.length < FENCE_PREFIX.length) {
    return FENCE_PREFIX.startsWith(leading);
  }
  if (!leading.startsWith(FENCE_PREFIX)) {
    return false;
  }
  const firstLineEnd = leading.indexOf("\n");
  if (firstLineEnd === -1) {
    // Info string still streaming in; keep holding only while it could
    // still become a recoverable fence.
    return RECOVERABLE_FENCE_REGEX.test(`${leading}\n`) || leading.length < 12;
  }
  return RECOVERABLE_FENCE_REGEX.test(leading.slice(0, firstLineEnd + 1));
}

function recoverableTagStillViable(leading: string): boolean {
  const lower = leading.toLowerCase();
  if (
    RECOVERABLE_TOOL_CALL_TAG.startsWith(lower) ||
    lower.startsWith(RECOVERABLE_TOOL_CALL_TAG)
  ) {
    return true;
  }

  for (const tagName of RECOVERABLE_QWEN_CALL_TAGS) {
    const tagStart = `<${tagName}`;
    if (tagStart.startsWith(lower)) {
      return true;
    }
    if (!lower.startsWith(tagStart)) {
      continue;
    }
    const next = lower[tagStart.length];
    return (
      next === undefined ||
      next === "=" ||
      next === ">" ||
      next === "/" ||
      ASCII_WHITESPACE_REGEX.test(next)
    );
  }

  return false;
}

/**
 * Streaming counterpart of `recoverToolCallFromJsonCandidates`: some models
 * emit a bare `{"name": ..., "arguments": ...}` payload without any protocol
 * markup. The generate path recovers those from the final text; without this
 * stage the stream path would leak the JSON as visible text.
 *
 * A text block that starts like a recoverable payload (bare JSON object,
 * array of calls, recoverable code fence, or a leaked tool-call tag) is held
 * back until the block ends (or the stream finishes). If the accumulated
 * block resolves to known tool calls it is re-emitted as full
 * tool-input/tool-call lifecycles; otherwise the block is flushed as
 * ordinary text. Each text block is evaluated independently, mirroring the
 * generate path's per-content-item recovery.
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
      return;
    }
    flushHeld(controller, closeBlock);
  };

  const heldBlockStillViable = (content: string): boolean => {
    if (content.length > MAX_HELD_BLOCK_LENGTH) {
      return false;
    }
    // A block can still resolve to a tool call when it starts with a bare
    // JSON object, a JSON array of calls (`[{`), a recoverable code fence,
    // or a literal tool-call tag leaking through a protocol that does not
    // know it — mirroring the candidate shapes of the non-streaming
    // recovery scan.
    const leading = content.trimStart();
    if (leading.length === 0 || leading.startsWith("{")) {
      return true;
    }
    if (leading.startsWith("[")) {
      const second = leading.slice(1).trimStart();
      return second.length === 0 || second.startsWith("{");
    }
    if (leading.startsWith("`")) {
      return fenceStillViable(leading);
    }
    return recoverableTagStillViable(leading);
  };

  return new TransformStream<
    LanguageModelV4StreamPart,
    LanguageModelV4StreamPart
  >({
    transform(part, controller) {
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
