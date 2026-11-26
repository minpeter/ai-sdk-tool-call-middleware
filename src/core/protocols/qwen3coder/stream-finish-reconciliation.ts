import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { generateToolCallId } from "../../utils/primitives/id";
import { shouldEmitRawToolCallTextOnError } from "../../utils/streaming/tool-input-streaming";
import type { ParserOptions } from "../protocol-interface";
import {
  normalizeToolCallInnerOpenVariants,
  QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_START_RE,
  QWEN3CODER_TOOL_PARSER_STREAM_NAME_OR_PARAM_SIGNAL_RE,
} from "./call-syntax";
import type {
  StreamController,
  StreamingCallState,
  ToolCallContainerState,
} from "./stream-types";

export interface QwenStreamMutableState {
  buffer: string;
  implicitCall: StreamingCallState | null;
  implicitCallOpenTag: string | null;
  toolCall: ToolCallContainerState | null;
}

export interface QwenStreamFinishReconcilerDeps {
  consumeCall: (
    controller: StreamController,
    callState: StreamingCallState,
    delta: string,
    outerNameAttr: string | null
  ) => { done: boolean; remainder: string };
  disableScanDeferral: () => void;
  drainStarts: (controller: StreamController) => void;
  finalizeCallAtFinish: (
    controller: StreamController,
    callState: StreamingCallState,
    outerNameAttr: string | null
  ) => { ok: boolean; trailingText: string };
  flushRecoveredBufferText: (
    controller: StreamController,
    text: string
  ) => void;
  flushRecoveredTrailingText: (
    controller: StreamController,
    callState: StreamingCallState,
    trailingText: string
  ) => void;
  flushSafeTextPrefix: (controller: StreamController) => void;
  flushText: (controller: StreamController, text?: string) => void;
  options?: ParserOptions;
  processToolCall: (controller: StreamController) => void;
  reportUnfinishedImplicitCallAtFinish: (
    controller: StreamController,
    raw: string,
    callState: StreamingCallState
  ) => void;
  reportUnfinishedToolCallAtFinish: (
    controller: StreamController,
    raw: string,
    meta: { toolCallId?: string; toolName?: string | null }
  ) => void;
  stripLeadingToolCallCloseTagsFromBuffer: () => void;
  tools: LanguageModelV4FunctionTool[];
}

function classifyUnknownToolCallAtFinish(
  toolCall: ToolCallContainerState,
  tools: LanguageModelV4FunctionTool[]
): void {
  toolCall.innerBuffer = normalizeToolCallInnerOpenVariants(
    toolCall.innerBuffer,
    tools
  );
  const callMatch = QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_START_RE.exec(
    toolCall.innerBuffer
  );
  const signalMatch =
    QWEN3CODER_TOOL_PARSER_STREAM_NAME_OR_PARAM_SIGNAL_RE.exec(
      toolCall.innerBuffer
    );
  if (
    callMatch &&
    (!signalMatch || (callMatch.index ?? 0) < (signalMatch.index ?? 0))
  ) {
    toolCall.mode = "multi";
  } else if (signalMatch) {
    toolCall.mode = "single";
    toolCall.activeCall = {
      endTagName: "tool_call",
      toolCallId: generateToolCallId(),
      toolName: toolCall.outerNameAttr,
      hasEmittedStart: false,
      partialParam: null,
      emittedInput: "",
      pendingToolInputParts: [],
      raw: toolCall.outerOpenTag,
      args: Object.create(null) as Record<string, unknown>,
      buffer: "",
    };
  }
}

function finalizeActiveContainerCallAtFinish(
  controller: StreamController,
  toolCall: ToolCallContainerState,
  activeCall: StreamingCallState,
  deps: QwenStreamFinishReconcilerDeps
): void {
  const result = deps.finalizeCallAtFinish(
    controller,
    activeCall,
    toolCall.outerNameAttr
  );
  if (result.ok) {
    toolCall.emittedToolCallCount += 1;
  }
  const shouldFlushTrailingText =
    result.ok || !shouldEmitRawToolCallTextOnError(deps.options);
  if (shouldFlushTrailingText && result.trailingText.length > 0) {
    deps.flushRecoveredTrailingText(
      controller,
      activeCall,
      result.trailingText
    );
  }
  if (!result.ok && toolCall.emittedToolCallCount === 0) {
    deps.reportUnfinishedToolCallAtFinish(controller, toolCall.raw, {
      toolCallId: activeCall.toolCallId,
      ...(activeCall.toolName ? { toolName: activeCall.toolName } : {}),
    });
  }
}

function reconcileOpenToolCallAtFinish(
  controller: StreamController,
  state: QwenStreamMutableState,
  deps: QwenStreamFinishReconcilerDeps
): void {
  deps.processToolCall(controller);
  const { toolCall } = state;
  if (!toolCall) {
    return;
  }

  if (toolCall.mode === "unknown") {
    classifyUnknownToolCallAtFinish(toolCall, deps.tools);
  }

  if (toolCall.mode === "single" && toolCall.activeCall) {
    toolCall.activeCall.buffer += toolCall.innerBuffer;
    toolCall.innerBuffer = "";
    finalizeActiveContainerCallAtFinish(
      controller,
      toolCall,
      toolCall.activeCall,
      deps
    );
  } else if (toolCall.mode === "multi") {
    if (toolCall.activeCall) {
      finalizeActiveContainerCallAtFinish(
        controller,
        toolCall,
        toolCall.activeCall,
        deps
      );
      toolCall.activeCall = null;
    } else if (toolCall.emittedToolCallCount === 0) {
      deps.reportUnfinishedToolCallAtFinish(controller, toolCall.raw, {
        toolName: toolCall.outerNameAttr,
      });
    }
  } else {
    deps.reportUnfinishedToolCallAtFinish(controller, toolCall.raw, {
      toolName: toolCall.outerNameAttr,
    });
  }

  state.toolCall = null;
}

function reconcileRemainingImplicitCallAtFinish(
  controller: StreamController,
  state: QwenStreamMutableState,
  deps: QwenStreamFinishReconcilerDeps
): void {
  const { implicitCall: callState, implicitCallOpenTag: openTag } = state;
  if (!callState) {
    deps.stripLeadingToolCallCloseTagsFromBuffer();
    deps.flushSafeTextPrefix(controller);
    deps.drainStarts(controller);
    return;
  }

  state.implicitCall = null;
  state.implicitCallOpenTag = null;

  const result = deps.finalizeCallAtFinish(controller, callState, null);
  const shouldFlushTrailingText =
    result.ok || !shouldEmitRawToolCallTextOnError(deps.options);
  if (shouldFlushTrailingText && result.trailingText.length > 0) {
    deps.flushRecoveredTrailingText(controller, callState, result.trailingText);
  }
  if (!result.ok && openTag) {
    deps.reportUnfinishedImplicitCallAtFinish(
      controller,
      callState.raw || openTag + callState.buffer,
      callState
    );
  }
}

export function reconcileQwenStreamFinish(
  controller: StreamController,
  state: QwenStreamMutableState,
  deps: QwenStreamFinishReconcilerDeps
): void {
  deps.disableScanDeferral();
  if (state.implicitCall) {
    const { done, remainder } = deps.consumeCall(
      controller,
      state.implicitCall,
      "",
      null
    );
    if (done) {
      state.implicitCall = null;
      state.implicitCallOpenTag = null;
      if (remainder.length > 0) {
        state.buffer = remainder + state.buffer;
      }
      deps.stripLeadingToolCallCloseTagsFromBuffer();
      deps.flushSafeTextPrefix(controller);
      deps.drainStarts(controller);
    }
  }

  if (state.toolCall) {
    reconcileOpenToolCallAtFinish(controller, state, deps);
  }

  reconcileRemainingImplicitCallAtFinish(controller, state, deps);

  if (state.buffer.length > 0) {
    deps.flushRecoveredBufferText(controller, state.buffer);
    state.buffer = "";
  }

  deps.flushText(controller);
}
