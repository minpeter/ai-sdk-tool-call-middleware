import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { recoverToolCallFromJsonCandidates } from "../utils/generated-text-json-recovery";
import { safeToolCallMetadataText } from "../utils/protocol-utils";
import { toolCallTextHasPrototypeSensitiveKey } from "../utils/prototype-sensitive-keys";
import {
  enqueueToolInputEndAndCall,
  shouldEmitRawToolCallTextOnError,
} from "../utils/tool-input-streaming";
import type { ParserOptions } from "./protocol-interface";
import {
  extractShorthandToolNameFromRaw,
  parseQwen3CoderToolParserToolCallSegment,
} from "./qwen3coder-call-parsing";
import {
  SALVAGE_MARKUP_ONLY_TEXT_REGEX,
  TOOL_CALL_CLOSE_RE,
} from "./qwen3coder-call-syntax";
import {
  hasProseOutsideXmlCalls,
  serializeQwenToolParserCalls,
} from "./qwen3coder-stream-salvage";
import type {
  StreamController,
  StreamingCallState,
} from "./qwen3coder-stream-types";

type FlushText = (controller: StreamController, text?: string) => void;

export function createQwenStreamFinishReporting({
  flushText,
  options,
  tools,
}: {
  flushText: FlushText;
  options?: ParserOptions;
  tools: LanguageModelV4FunctionTool[];
}) {
  /**
   * Cross-format salvage before dropping an unfinished tool_call block:
   * some models emit Hermes-style JSON payloads inside `<tool_call>` tags
   * regardless of the Qwen prompt (observed live on LiquidAI LFM2). The
   * shared recovery only fires when the block is nothing but resolvable
   * payloads plus markup remnants.
   */
  const trySalvageForeignFormatCalls = (
    controller: StreamController,
    rawToolCall: string
  ): boolean => {
    const recovered = recoverToolCallFromJsonCandidates(rawToolCall, tools);
    if (!recovered) {
      return false;
    }
    const calls = recovered.filter(
      (part): part is Extract<typeof part, { type: "tool-call" }> =>
        part.type === "tool-call"
    );
    const hasProse = recovered.some(
      (part) =>
        part.type === "text" && !SALVAGE_MARKUP_ONLY_TEXT_REGEX.test(part.text)
    );
    if (calls.length === 0 || hasProse) {
      return false;
    }
    for (const call of calls) {
      controller.enqueue({
        type: "tool-input-start",
        id: call.toolCallId,
        toolName: call.toolName,
      });
      if (call.input.length > 0) {
        controller.enqueue({
          type: "tool-input-delta",
          id: call.toolCallId,
          delta: call.input,
        });
      }
      controller.enqueue({ type: "tool-input-end", id: call.toolCallId });
      controller.enqueue(call);
    }
    return true;
  };

  /**
   * Finish-time backstop: re-run the (variant-tolerant) generate-path parser
   * over the buffered tool_call markup before dropping it. This recovers
   * shapes the incremental state machine cannot stream, e.g. GLM-4.7's
   * `<tool_call>write_file` + schema-property parameter tags.
   */
  const trySalvageXmlToolCallAtFinish = (
    controller: StreamController,
    rawToolCall: string
  ): boolean => {
    const synthetic = TOOL_CALL_CLOSE_RE.test(rawToolCall)
      ? rawToolCall
      : `${rawToolCall}</tool_call>`;
    if (hasProseOutsideXmlCalls(synthetic, tools)) {
      return false;
    }
    const calls = parseQwen3CoderToolParserToolCallSegment(synthetic, tools);
    if (!calls || calls.length === 0) {
      return false;
    }
    const serializedCalls = serializeQwenToolParserCalls(calls, tools);
    if (!serializedCalls) {
      return false;
    }
    for (const call of serializedCalls) {
      controller.enqueue({
        type: "tool-input-start",
        id: call.toolCallId,
        toolName: call.toolName,
      });
      if (call.input.length > 0) {
        controller.enqueue({
          type: "tool-input-delta",
          id: call.toolCallId,
          delta: call.input,
        });
      }
      enqueueToolInputEndAndCall({
        controller,
        id: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
      });
    }
    return true;
  };

  const reportUnfinishedToolCallAtFinish = (
    controller: StreamController,
    rawToolCall: string,
    metadata: { toolCallId?: string; toolName?: string | null } = {}
  ) => {
    if (trySalvageXmlToolCallAtFinish(controller, rawToolCall)) {
      return;
    }
    if (trySalvageForeignFormatCalls(controller, rawToolCall)) {
      return;
    }
    const shouldEmitRaw = shouldEmitRawToolCallTextOnError(options);
    const toolName =
      metadata.toolName ?? extractShorthandToolNameFromRaw(rawToolCall);
    options?.onError?.(
      shouldEmitRaw
        ? "Could not complete streaming Qwen3CoderToolParser XML tool call at finish; emitting original text."
        : "Could not complete streaming Qwen3CoderToolParser XML tool call at finish.",
      {
        toolCall: safeToolCallMetadataText(rawToolCall),
        ...(metadata.toolCallId ? { toolCallId: metadata.toolCallId } : {}),
        ...(toolName ? { toolName } : {}),
        dropReason: "unfinished-tool-call",
      }
    );
    if (shouldEmitRaw && !toolCallTextHasPrototypeSensitiveKey(rawToolCall)) {
      flushText(controller, rawToolCall);
    }
  };

  const reportUnfinishedImplicitCallAtFinish = (
    controller: StreamController,
    rawCallText: string,
    callState: StreamingCallState
  ) => {
    const shouldEmitRaw = shouldEmitRawToolCallTextOnError(options);
    options?.onError?.(
      shouldEmitRaw
        ? "Could not complete streaming Qwen3CoderToolParser call block at finish; emitting original text."
        : "Could not complete streaming Qwen3CoderToolParser call block at finish.",
      {
        toolCall: safeToolCallMetadataText(rawCallText),
        toolCallId: callState.toolCallId,
        ...(callState.toolName ? { toolName: callState.toolName } : {}),
        dropReason: "unfinished-tool-call",
      }
    );
    if (shouldEmitRaw && !toolCallTextHasPrototypeSensitiveKey(rawCallText)) {
      flushText(controller, rawCallText);
    }
  };

  return {
    reportUnfinishedImplicitCallAtFinish,
    reportUnfinishedToolCallAtFinish,
  };
}
