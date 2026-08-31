import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import {
  consumeMarkdownCodeText,
  createMarkdownCodeContext,
  markdownCodeContextSuppressesToolCall,
} from "../utils/markdown-code-context";
import { createFlushTextHandler } from "../utils/protocol-utils";
import {
  MAX_GLM5_CALL_BODY_LENGTH,
  type ResolvedGlm5ProtocolOptions,
} from "./glm5-call-parsing";
import {
  appendGlm5StreamBody,
  createGlm5StreamBody,
  sliceGlm5StreamBody,
  truncateGlm5StreamBody,
} from "./glm5-stream-body";
import {
  createGlm5CloseTagScanner,
  findGlm5ToolCallOpen,
  materializeRawGlm5Call,
  scanGlm5ToolCallClose,
} from "./glm5-stream-close-scanner";
import { createGlm5StreamLifecycle } from "./glm5-stream-lifecycle";
import { type ActiveGlm5Call, createActiveGlm5Call } from "./glm5-stream-state";
import { createFlushSafeGlm5TextBuffer } from "./glm5-stream-text-buffer";
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
  let currentTextId: string | null = null;
  let hasEmittedTextStart = false;
  const markdownContext = createMarkdownCodeContext();
  let streamPoisoned = false;

  const baseFlushText = createFlushTextHandler(
    () => currentTextId,
    (value) => {
      currentTextId = value;
    },
    () => hasEmittedTextStart,
    (value) => {
      hasEmittedTextStart = value;
    }
  );
  const flushText = (controller: StreamController, text?: string) => {
    if (text) {
      consumeMarkdownCodeText(markdownContext, text);
    }
    baseFlushText(controller, text);
  };
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

  const queueRemainder = (call: ActiveGlm5Call, remainder: string) => {
    if (!call.suppressRemainderResync) {
      textBuffer = `${remainder}${textBuffer}`;
    }
  };

  const processActiveCall = (controller: StreamController): boolean => {
    const call = activeCall;
    if (!call || call.oversized) {
      return false;
    }
    const close = scanGlm5ToolCallClose(call, protocolOptions, tools);
    if (!close) {
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
    queueRemainder(call, remainder);
    return true;
  };

  const processBufferedText = (controller: StreamController) => {
    while (true) {
      if (activeCall) {
        if (!processActiveCall(controller)) {
          return;
        }
        continue;
      }

      const open = findGlm5ToolCallOpen(textBuffer, 0);
      if (!open) {
        textBuffer = flushSafeTextBuffer(controller, textBuffer);
        return;
      }
      const prefix = textBuffer.slice(0, open.start);
      if (prefix.length > 0) {
        flushText(controller, prefix);
      }
      const insideMarkdownCode =
        markdownCodeContextSuppressesToolCall(markdownContext);
      flushText(controller);
      const body = textBuffer.slice(open.end, open.end + bodyLengthLimit);
      const remainderStart = open.end + body.length;
      activeCall = createActiveGlm5Call({
        body: createGlm5StreamBody(body),
        closeScanner: createGlm5CloseTagScanner(),
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
    queueRemainder(completedCall, remainder);
    return true;
  };

  const finalizePending = (controller: StreamController) => {
    if (streamPoisoned) {
      if (activeCall) {
        lifecycle.closeToolInput(controller, activeCall);
      }
      activeCall = null;
      textBuffer = "";
      flushText(controller);
      return;
    }
    processBufferedText(controller);
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

  return new TransformStream<
    LanguageModelV4StreamPart,
    LanguageModelV4StreamPart
  >({
    flush(controller) {
      finalizePending(controller);
    },

    transform(part, controller) {
      if (streamPoisoned) {
        if (part.type === "finish") {
          finalizePending(controller);
          controller.enqueue(part);
        }
        return;
      }
      if (part.type === "text-start" || part.type === "text-end") {
        return;
      }
      if (part.type === "text-delta") {
        if (activeCall) {
          const retainedLength = Math.max(
            0,
            bodyLengthLimit - activeCall.body.length
          );
          const retained = part.delta.slice(0, retainedLength);
          appendGlm5StreamBody(activeCall.body, retained);
          const overflow = part.delta.slice(retainedLength);
          textBuffer += overflow;
          if (
            overflow.length === 0 &&
            !STRUCTURAL_TRIGGER_RE.test(retained) &&
            activeCall.body.length < activeCall.nextProgressParseLength
          ) {
            return;
          }
        } else {
          textBuffer += part.delta;
        }
        processBufferedText(controller);
        return;
      }
      if (part.type === "finish") {
        finalizePending(controller);
        controller.enqueue(part);
        return;
      }
      controller.enqueue(part);
    },
  });
}
