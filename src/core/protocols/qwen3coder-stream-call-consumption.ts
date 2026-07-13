import { escapeRegExp } from "../utils/regex";
import { stripLeadingCallCloseTags } from "./qwen3coder-call-parsing";
import { QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_TAG_RE } from "./qwen3coder-call-syntax";

import type {
  StreamController,
  StreamingCallState,
} from "./qwen3coder-stream-types";

interface CallConsumptionOptions {
  finalizeCall: (
    controller: StreamController,
    callState: StreamingCallState,
    fallbackToolName: string | null,
    rawToolCallText?: string | null
  ) => boolean;
  onFinalized: () => void;
  parseStreamingCallContent: (
    controller: StreamController,
    callState: StreamingCallState,
    content: string,
    allowEndOfString: boolean
  ) => string;
}

export function createQwenStreamCallConsumption({
  finalizeCall,
  onFinalized,
  parseStreamingCallContent,
}: CallConsumptionOptions) {
  // This cache is scoped to createStreamParser (per-stream), so it cannot outlive
  // one stream invocation.
  // It is bounded by the small set of endTagName values {call, function, tool,
  // invoke, tool_call}, so this is effectively ~5 entries max.
  // Eviction is unnecessary because the keyspace is fixed and tiny.
  const closeTagCache = new Map<string, RegExp>();

  const getCloseTagPattern = (endTagName: string): RegExp => {
    const cached = closeTagCache.get(endTagName);
    if (cached) {
      return cached;
    }

    const created = new RegExp(
      `<\\s*\\/\\s*${escapeRegExp(endTagName)}\\s*>`,
      "i"
    );
    closeTagCache.set(endTagName, created);
    return created;
  };

  const getNextCallStartInBuffer = (callState: StreamingCallState): number => {
    if (callState.endTagName === "tool_call") {
      return -1;
    }
    const match = QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_TAG_RE.exec(
      callState.buffer
    );
    return match?.index ?? -1;
  };

  const finalizeStreamingCall = (
    controller: StreamController,
    callState: StreamingCallState,
    fallbackToolName: string | null,
    remainder: string
  ) => {
    const rawToolCallText =
      remainder.length > 0 && callState.raw.endsWith(remainder)
        ? callState.raw.slice(0, -remainder.length)
        : callState.raw;
    const ok = finalizeCall(
      controller,
      callState,
      fallbackToolName,
      rawToolCallText
    );
    if (ok) {
      onFinalized();
    }
  };

  const consumeCallAtNextBoundary = (
    controller: StreamController,
    callState: StreamingCallState,
    fallbackToolName: string | null,
    nextCallStart: number
  ): { done: true; remainder: string } => {
    const beforeNextCall = callState.buffer.slice(0, nextCallStart);
    const afterNextCall = callState.buffer.slice(nextCallStart);

    callState.buffer = parseStreamingCallContent(
      controller,
      callState,
      beforeNextCall,
      true
    );
    finalizeStreamingCall(
      controller,
      callState,
      fallbackToolName,
      afterNextCall
    );
    return { done: true, remainder: afterNextCall };
  };

  const consumeCall = (
    controller: StreamController,
    callState: StreamingCallState,
    incoming: string,
    fallbackToolName: string | null
  ): { done: boolean; remainder: string } => {
    callState.buffer += incoming;
    callState.raw += incoming;

    const closeMatch = getCloseTagPattern(callState.endTagName).exec(
      callState.buffer
    );
    const closeStart = closeMatch?.index ?? -1;
    const nextCallStart = getNextCallStartInBuffer(callState);
    const shouldCloseAtNextBoundary =
      nextCallStart !== -1 && (closeStart === -1 || nextCallStart < closeStart);

    if (shouldCloseAtNextBoundary) {
      return consumeCallAtNextBoundary(
        controller,
        callState,
        fallbackToolName,
        nextCallStart
      );
    }

    if (!closeMatch) {
      callState.buffer = parseStreamingCallContent(
        controller,
        callState,
        callState.buffer,
        false
      );
      return { done: false, remainder: "" };
    }

    const closeEnd = closeStart + (closeMatch[0]?.length ?? 0);
    const beforeClose = callState.buffer.slice(0, closeStart);
    const afterClose = callState.buffer.slice(closeEnd);

    parseStreamingCallContent(controller, callState, beforeClose, true);
    callState.buffer = "";
    finalizeStreamingCall(controller, callState, fallbackToolName, afterClose);
    return { done: true, remainder: afterClose };
  };

  const finalizeCallAtFinish = (
    controller: StreamController,
    callState: StreamingCallState,
    fallbackToolName: string | null
  ): { ok: boolean; trailingText: string } => {
    callState.buffer = parseStreamingCallContent(
      controller,
      callState,
      callState.buffer,
      true
    );
    const trailingText = stripLeadingCallCloseTags(callState.buffer);
    callState.buffer = "";
    const ok = finalizeCall(controller, callState, fallbackToolName, null);
    return {
      ok,
      trailingText,
    };
  };

  return { consumeCall, finalizeCallAtFinish };
}
