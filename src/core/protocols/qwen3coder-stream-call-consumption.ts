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

  // While a large parameter value streams in, every chunk used to rescan the
  // whole accumulated call buffer (close-tag regex, next-call regex, and a
  // full re-parse including toLowerCase), which is O(total) per chunk and
  // quadratic overall. Scans are amortized instead: once the buffer exceeds
  // SCAN_DEFER_MIN_BUFFER_LENGTH, a full scan only runs after the buffer has
  // grown by ~1/8 since the previous scan. Geometric spacing keeps total scan
  // work linear. Final results are unchanged — deferral only delays when a
  // pending close tag is observed, and it is disabled (plus a catch-up scan
  // runs) before finish reconciliation. Below the threshold, behavior is
  // byte-identical, including tool-input progress timing.
  const SCAN_DEFER_MIN_BUFFER_LENGTH = 4096;
  const scanThresholds = new WeakMap<StreamingCallState, number>();
  let scanDeferralEnabled = true;

  const disableScanDeferral = () => {
    scanDeferralEnabled = false;
  };

  const shouldDeferScan = (callState: StreamingCallState): boolean => {
    if (!scanDeferralEnabled) {
      return false;
    }
    const length = callState.buffer.length;
    if (length <= SCAN_DEFER_MIN_BUFFER_LENGTH) {
      return false;
    }
    const threshold = scanThresholds.get(callState);
    return threshold !== undefined && length < threshold;
  };

  const scheduleNextScan = (callState: StreamingCallState) => {
    const length = callState.buffer.length;
    scanThresholds.set(callState, length + Math.max(512, length >> 3));
  };

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

    if (shouldDeferScan(callState)) {
      return { done: false, remainder: "" };
    }

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
      scheduleNextScan(callState);
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

  return { consumeCall, disableScanDeferral, finalizeCallAtFinish };
}
