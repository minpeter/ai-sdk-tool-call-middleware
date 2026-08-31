import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import {
  MAX_GLM5_CALL_BODY_LENGTH,
  type ResolvedGlm5ProtocolOptions,
} from "./glm5-call-parsing";
import { createGlm5MarkdownStream } from "./glm5-markdown-stream";
import {
  createGlm5StreamBody,
  sliceGlm5StreamBody,
  truncateGlm5StreamBody,
} from "./glm5-stream-body";
import { resolveGlm5BodyLimitBoundary } from "./glm5-stream-boundary";
import {
  appendGlm5ScannedStreamBody,
  createGlm5CloseTagScanner,
  findGlm5ToolCallOpen,
  materializeRawGlm5Call,
  scanGlm5ToolCallClose,
} from "./glm5-stream-close-scanner";
import { createGlm5StreamLifecycle } from "./glm5-stream-lifecycle";
import {
  type ActiveGlm5Call,
  createActiveGlm5Call,
  prependGlm5StreamRemainder,
} from "./glm5-stream-state";
import { createFlushSafeGlm5TextBuffer } from "./glm5-stream-text-buffer";
import { createGlm5StreamTransform } from "./glm5-stream-transform";
import type { ParserOptions } from "./protocol-interface";

type StreamController =
  TransformStreamDefaultController<LanguageModelV4StreamPart>;

const STRUCTURAL_TRIGGER_RE = /[<>]/;

export function createGlm5StreamParser({
  bodyLengthLimit = MAX_GLM5_CALL_BODY_LENGTH,
  tools,
  options,
  protocolOptions,
}: {
  bodyLengthLimit?: number;
  tools: LanguageModelV4FunctionTool[];
  options?: ParserOptions;
  protocolOptions: ResolvedGlm5ProtocolOptions;
}): TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart> {
  let textBuffer = "";
  let activeCall: ActiveGlm5Call | null = null;
  let streamPoisoned = false;

  const markdownStream = createGlm5MarkdownStream();
  const { flushText } = markdownStream;
  const lifecycle = createGlm5StreamLifecycle({
    bodyLengthLimit,
    flushText,
    onStreamPoisoned: () => {
      textBuffer = "";
      streamPoisoned = true;
    },
    options,
    protocolOptions,
    tools,
  });

  const flushSafeTextBuffer = createFlushSafeGlm5TextBuffer({
    flushText,
    tools,
  });

  const processActiveCall = (controller: StreamController): boolean => {
    const call = activeCall;
    if (!call || call.oversized) {
      return false;
    }
    const boundary = resolveGlm5BodyLimitBoundary({
      bodyLengthLimit,
      call,
      controller,
      lifecycle,
      textBuffer,
    });
    ({ textBuffer } = boundary);
    if (boundary.stop) {
      return false;
    }
    const close = scanGlm5ToolCallClose(call, protocolOptions, tools);
    if (!close) {
      if (textBuffer.length > 0 && call.markdownCodePrefixed) {
        markdownStream.beginOversizedFence(
          controller,
          materializeRawGlm5Call(call)
        );
        activeCall = null;
        const resync = markdownStream.resynchronize(controller, textBuffer);
        textBuffer = resync.remainder;
        return resync.closed;
      }
      if (textBuffer.length > 0) {
        lifecycle.markCallOversized(controller, call);
      } else {
        lifecycle.updateToolInputProgress(controller, call);
      }
      return false;
    }

    const remainder = sliceGlm5StreamBody(call.body, close.end);
    truncateGlm5StreamBody(call.body, close.start);
    if (call.closeSelectionRejected) {
      lifecycle.markCallFailed(
        controller,
        call,
        materializeRawGlm5Call(call, close.raw)
      );
    }
    lifecycle.finalizeCall(controller, call, close.raw, false);
    activeCall = null;
    textBuffer = prependGlm5StreamRemainder(call, remainder, textBuffer);
    return true;
  };

  const processBufferedText = (
    controller: StreamController,
    terminal = false
  ) => {
    while (true) {
      if (activeCall) {
        if (!processActiveCall(controller)) {
          return;
        }
        continue;
      }

      const open = findGlm5ToolCallOpen(textBuffer, 0);
      if (!open) {
        if (terminal && !markdownStream.isBareCallRecoveryEligible()) {
          flushText(controller, textBuffer);
          textBuffer = "";
          return;
        }
        textBuffer = flushSafeTextBuffer(controller, textBuffer, terminal);
        return;
      }
      markdownStream.disableBareCallRecovery();
      const prefix = textBuffer.slice(0, open.start);
      if (prefix.length > 0) {
        flushText(controller, prefix);
      }
      const insideMarkdownCode = markdownStream.isInsideCode();
      flushText(controller);
      const body = textBuffer.slice(open.end, open.end + bodyLengthLimit);
      const remainderStart = open.end + body.length;
      activeCall = createActiveGlm5Call({
        body: createGlm5StreamBody(body),
        closeScanner: createGlm5CloseTagScanner(body),
        markdownCodePrefixed: insideMarkdownCode,
        openTag: open.raw,
      });
      textBuffer = textBuffer.slice(remainderStart);
    }
  };

  const finalizeDeferredClose = (controller: StreamController): boolean => {
    const close =
      activeCall?.closeScanner.pendingClose ??
      activeCall?.closeScanner.firstClose;
    if (!(activeCall && !activeCall.oversized && close)) {
      return false;
    }
    const completedCall = activeCall;
    const remainder = sliceGlm5StreamBody(completedCall.body, close.end);
    truncateGlm5StreamBody(completedCall.body, close.start);
    lifecycle.finalizeCall(controller, completedCall, close.raw, false);
    activeCall = null;
    textBuffer = prependGlm5StreamRemainder(
      completedCall,
      remainder,
      textBuffer
    );
    return true;
  };

  const finalizePending = (controller: StreamController) => {
    if (markdownStream.finalizeOversizedFence(controller)) {
      textBuffer = "";
      flushText(controller);
      return;
    }
    if (streamPoisoned) {
      if (activeCall) {
        lifecycle.closeToolInput(controller, activeCall);
      }
      activeCall = null;
      textBuffer = "";
      flushText(controller);
      return;
    }
    processBufferedText(controller, true);
    if (activeCall?.closeScanner.nestedToolCallSeen) {
      activeCall.suppressRemainderResync = true;
      lifecycle.markCallFailed(
        controller,
        activeCall,
        materializeRawGlm5Call(activeCall)
      );
    }
    while (finalizeDeferredClose(controller)) {
      processBufferedText(controller);
    }
    if (activeCall) {
      const call = activeCall;
      activeCall = null;
      if (protocolOptions.recoverIncompleteToolCalls) {
        lifecycle.finalizeCall(controller, call, "", true);
      } else {
        const raw = materializeRawGlm5Call(call);
        lifecycle.markCallFailed(controller, call, raw);
        lifecycle.emitRawFallback(controller, raw);
      }
    }
    if (textBuffer.length > 0) {
      flushText(controller, textBuffer);
      textBuffer = "";
    }
    flushText(controller);
  };

  const processTextDelta = (controller: StreamController, delta: string) => {
    if (activeCall) {
      const retainedLength = Math.max(
        0,
        bodyLengthLimit - activeCall.body.length
      );
      const retained = delta.slice(0, retainedLength);
      appendGlm5ScannedStreamBody(activeCall, retained);
      const overflow = delta.slice(retainedLength);
      textBuffer += overflow;
      if (
        overflow.length === 0 &&
        !STRUCTURAL_TRIGGER_RE.test(retained) &&
        activeCall.body.length < activeCall.nextProgressParseLength
      ) {
        return;
      }
    } else {
      textBuffer += delta;
    }
    const resync = markdownStream.resynchronize(controller, textBuffer);
    textBuffer = resync.remainder;
    if (resync.closed) {
      processBufferedText(controller);
    }
  };

  return createGlm5StreamTransform({
    finalizePending,
    isPoisoned: () => streamPoisoned,
    processTextDelta,
  });
}
