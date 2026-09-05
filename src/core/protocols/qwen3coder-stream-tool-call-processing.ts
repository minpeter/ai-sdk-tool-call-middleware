import {
  normalizeStreamToolCallInnerOpenVariants,
  QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_START_RE,
  QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_TAG_RE,
  QWEN3CODER_TOOL_PARSER_STREAM_NAME_OR_PARAM_SIGNAL_RE,
  QWEN3CODER_TOOL_PARSER_STREAM_SELF_CLOSING_TAG_RE,
  QWEN3CODER_TOOL_PARSER_STREAM_TOOL_CALL_CLOSE_TAG_RE,
} from "./qwen3coder-call-syntax";
import {
  getAttributeValue,
  getShorthandValue,
} from "./qwen3coder-param-tag-parsing";
import {
  createStreamingCall,
  type ProcessingContext,
} from "./qwen3coder-stream-tool-call-context";
import type {
  StreamController,
  ToolCallContainerState,
} from "./qwen3coder-stream-types";

function resolveUnknownMode(
  controller: StreamController,
  toolCall: ToolCallContainerState,
  context: ProcessingContext
): boolean {
  const normalization = normalizeStreamToolCallInnerOpenVariants(
    toolCall.innerBuffer,
    context.tools
  );
  if (normalization.status === "incomplete") {
    return false;
  }
  if (normalization.status === "rewritten") {
    toolCall.innerBuffer = normalization.value;
  }
  const callMatch = QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_START_RE.exec(
    toolCall.innerBuffer
  );
  const signalMatch =
    QWEN3CODER_TOOL_PARSER_STREAM_NAME_OR_PARAM_SIGNAL_RE.exec(
      toolCall.innerBuffer
    );
  if (callMatch && (!signalMatch || callMatch.index < signalMatch.index)) {
    toolCall.mode = "multi";
    return true;
  }
  if (!signalMatch) {
    return false;
  }

  toolCall.mode = "single";
  const activeCall = createStreamingCall(
    "tool_call",
    toolCall.outerNameAttr,
    toolCall.outerOpenTag
  );
  toolCall.activeCall = activeCall;
  if (toolCall.outerNameAttr) {
    context.maybeEmitToolInputStart(controller, activeCall);
  }
  return true;
}

function continueAfterContainer(
  controller: StreamController,
  remainder: string,
  context: ProcessingContext
): void {
  context.setToolCall(null);
  if (remainder.length > 0) {
    context.setBuffer(remainder + context.getBuffer());
  }
  context.flushSafeTextPrefix(controller);
  context.startToolCallIfPresent();
}

function processSingleCall(
  controller: StreamController,
  toolCall: ToolCallContainerState,
  context: ProcessingContext
): boolean {
  const callState = toolCall.activeCall;
  if (!callState) {
    return false;
  }
  const { done, remainder } = context.consumeCall(
    controller,
    callState,
    toolCall.innerBuffer,
    toolCall.outerNameAttr
  );
  toolCall.innerBuffer = "";
  if (!done) {
    return false;
  }
  continueAfterContainer(controller, remainder, context);
  return true;
}

function processActiveMultiCall(
  controller: StreamController,
  toolCall: ToolCallContainerState,
  context: ProcessingContext
): boolean {
  const callState = toolCall.activeCall;
  if (!callState) {
    return true;
  }
  const { done, remainder } = context.consumeCall(
    controller,
    callState,
    toolCall.innerBuffer,
    toolCall.outerNameAttr
  );
  toolCall.innerBuffer = "";
  if (!done) {
    return false;
  }
  toolCall.activeCall = null;
  toolCall.innerBuffer = remainder;
  return true;
}

type MultiBoundary =
  | {
      readonly kind: "call";
      readonly openTag: string;
      readonly tagName: string;
    }
  | { readonly kind: "close"; readonly length: number }
  | { readonly kind: "incomplete" };

function findMultiBoundary(toolCall: ToolCallContainerState): MultiBoundary {
  const closeMatch = QWEN3CODER_TOOL_PARSER_STREAM_TOOL_CALL_CLOSE_TAG_RE.exec(
    toolCall.innerBuffer
  );
  const callMatch = QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_TAG_RE.exec(
    toolCall.innerBuffer
  );
  if (!(closeMatch || callMatch)) {
    return { kind: "incomplete" };
  }

  const closeIndex = closeMatch?.index ?? -1;
  const callIndex = callMatch?.index ?? -1;
  const chooseClose =
    closeIndex !== -1 && (callIndex === -1 || closeIndex < callIndex);
  const nextIndex = chooseClose ? closeIndex : callIndex;
  if (nextIndex > 0) {
    toolCall.innerBuffer = toolCall.innerBuffer.slice(nextIndex);
  }
  if (chooseClose) {
    return { kind: "close", length: closeMatch?.[0]?.length ?? 0 };
  }
  if (!callMatch) {
    return { kind: "incomplete" };
  }
  return {
    kind: "call",
    openTag: callMatch[0] ?? "",
    tagName: (callMatch[1] ?? "").toLowerCase(),
  };
}

function processNewMultiCall(
  controller: StreamController,
  toolCall: ToolCallContainerState,
  boundary: Extract<MultiBoundary, { kind: "call" }>,
  context: ProcessingContext
): void {
  const rest = toolCall.innerBuffer.slice(boundary.openTag.length);
  const toolName =
    getAttributeValue(boundary.openTag, "name") ??
    getShorthandValue(boundary.openTag);
  const call = createStreamingCall(
    boundary.tagName,
    toolName ?? toolCall.outerNameAttr,
    boundary.openTag
  );
  if (
    QWEN3CODER_TOOL_PARSER_STREAM_SELF_CLOSING_TAG_RE.test(boundary.openTag)
  ) {
    if (context.finalizeCall(controller, call, call.toolName, call.raw)) {
      toolCall.emittedToolCallCount += 1;
    }
    toolCall.innerBuffer = rest;
    return;
  }
  if (toolName) {
    context.maybeEmitToolInputStart(controller, call);
  }
  call.toolName = toolName;
  toolCall.activeCall = call;
  toolCall.innerBuffer = rest;
}

function processMultiCall(
  controller: StreamController,
  toolCall: ToolCallContainerState,
  context: ProcessingContext
): boolean {
  if (toolCall.activeCall) {
    return processActiveMultiCall(controller, toolCall, context);
  }
  const boundary = findMultiBoundary(toolCall);
  if (boundary.kind === "incomplete") {
    return false;
  }
  if (boundary.kind === "close") {
    const remainder = toolCall.innerBuffer.slice(boundary.length);
    continueAfterContainer(controller, remainder, context);
    return true;
  }
  processNewMultiCall(controller, toolCall, boundary, context);
  return true;
}

export function createQwenStreamToolCallProcessor(
  context: ProcessingContext
): (controller: StreamController) => void {
  return (controller) => {
    while (true) {
      const toolCall = context.getToolCall();
      if (!toolCall) {
        return;
      }
      if (
        toolCall.mode === "unknown" &&
        !resolveUnknownMode(controller, toolCall, context)
      ) {
        return;
      }
      if (toolCall.mode === "single") {
        if (!processSingleCall(controller, toolCall, context)) {
          return;
        }
        continue;
      }
      if (!processMultiCall(controller, toolCall, context)) {
        return;
      }
    }
  };
}
