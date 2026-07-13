import { generateToolCallId } from "../utils/id";
import { safeToolCallMetadataText } from "../utils/protocol-utils";
import { toolCallTextHasPrototypeSensitiveKey } from "../utils/prototype-sensitive-keys";
import type { ParserOptions } from "./protocol-interface";
import {
  stripLeadingToolCallCloseTags,
  stripTrailingToolCallCloseTags,
} from "./qwen3coder-call-syntax";
import { emitTextWithSensitiveStandaloneParamDrops } from "./qwen3coder-sensitive-standalone-param";
import type {
  StreamController,
  StreamingCallState,
} from "./qwen3coder-stream-types";

type FlushText = (controller: StreamController, text?: string) => void;

export function createQwenStreamTextRecovery({
  flushText,
  options,
}: {
  flushText: FlushText;
  options?: ParserOptions;
}) {
  const flushRecoveredTrailingText = (
    controller: StreamController,
    callState: StreamingCallState,
    trailingText: string
  ) => {
    if (trailingText.length === 0) {
      return;
    }
    if (toolCallTextHasPrototypeSensitiveKey(trailingText)) {
      const raw = `${callState.raw}${trailingText}`;
      options?.onError?.("Dropped sensitive Qwen3CoderToolParser text.", {
        toolCallId: callState.toolCallId,
        toolCall: safeToolCallMetadataText(raw),
        ...(callState.toolName ? { toolName: callState.toolName } : {}),
        dropReason: "sensitive-tool-call-trailing-text",
      });
      return;
    }
    flushText(controller, trailingText);
  };

  const flushRecoveredBufferText = (
    controller: StreamController,
    value: string
  ) => {
    const text = stripTrailingToolCallCloseTags(
      stripLeadingToolCallCloseTags(value)
    );
    if (text.length === 0) {
      return;
    }
    if (toolCallTextHasPrototypeSensitiveKey(text)) {
      const droppedBoundedSpan = emitTextWithSensitiveStandaloneParamDrops({
        text,
        emitText: (segment) => {
          flushText(controller, segment);
        },
        onSensitiveText: (sensitiveText) => {
          options?.onError?.("Dropped sensitive Qwen3CoderToolParser text.", {
            toolCallId: generateToolCallId(),
            toolCall: safeToolCallMetadataText(sensitiveText),
            dropReason: "sensitive-tool-call-trailing-text",
          });
        },
      });
      if (droppedBoundedSpan) {
        return;
      }
      options?.onError?.("Dropped sensitive Qwen3CoderToolParser text.", {
        toolCallId: generateToolCallId(),
        toolCall: safeToolCallMetadataText(text),
        dropReason: "sensitive-tool-call-trailing-text",
      });
      return;
    }
    flushText(controller, text);
  };

  return { flushRecoveredBufferText, flushRecoveredTrailingText };
}
