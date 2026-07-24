import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { generateToolCallId } from "../utils/id";
import {
  consumeMarkdownCodeText,
  createMarkdownCodeContext,
  markdownCodeContextSuppressesToolCall,
} from "../utils/markdown-code-context";
import {
  createFlushTextHandler,
  safeToolCallMetadataError,
  safeToolCallMetadataText,
} from "../utils/protocol-utils";
import { toolCallTextHasPrototypeSensitiveKey } from "../utils/prototype-sensitive-keys";
import {
  emitFinalizedToolInputLifecycle,
  emitToolInputProgressDelta,
  enqueueToolInputEnd,
  enqueueToolInputEndAndCall,
  shouldEmitRawToolCallTextOnError,
} from "../utils/tool-input-streaming";
import { parseGlm5AnchoredBareToolCall } from "./glm5-bare-tool-call";
import {
  hasExplicitlyClosedGlm5TaggedBody,
  MAX_GLM5_CALL_BODY_LENGTH,
  parseGlm5CallBody,
  type ResolvedGlm5ProtocolOptions,
  stringifyGlm5CallInput,
} from "./glm5-call-parsing";
import type { ParserOptions } from "./protocol-interface";

type StreamController =
  TransformStreamDefaultController<LanguageModelV4StreamPart>;

interface ActiveCall {
  body: string;
  closeScanner: CloseTagScanner;
  closeSelectionRejected: boolean;
  emittedInput: string;
  failed: boolean;
  id: string | null;
  inputEnded: boolean;
  markdownCodePrefixed: boolean;
  nextProgressParseLength: number;
  openTag: string;
  oversized: boolean;
  suppressRemainderResync: boolean;
  toolName: string | null;
}

interface CloseTagScanner {
  argValueDepth: number;
  candidateStart: number;
  closeCandidateCount: number;
  cursor: number;
  firstClose: TagMatch | null;
  nestedToolCallDepth: number;
  nestedToolCallSeen: boolean;
  pendingClose: TagMatch | null;
}

interface TagMatch {
  end: number;
  raw: string;
  start: number;
}

const TOOL_CALL_OPEN_RE = /<\s*tool_call\s*>/i;
const TOOL_CALL_NAME = "tool_call";
const GLM5_STRUCTURAL_TAG_NAMES = [
  "arg_key",
  "arg_value",
  TOOL_CALL_NAME,
] as const;
const STREAM_STRUCTURAL_TAG_RE = /^<\s*(\/?)\s*(arg_value|tool_call)\s*>$/i;
const STRUCTURAL_RECOVERY_CODES = new Set([
  "recovered-missing-arg-key-close",
  "recovered-missing-arg-value-close",
]);
const MAX_GLM5_TOOL_CALL_CLOSE_CANDIDATES = 256;
const OVERSIZED_GLM5_TOOL_CALL_METADATA =
  "[oversized GLM-5.2 tool call omitted]";
const WHITESPACE_RE = /\s/;

function findTag(text: string, from: number, pattern: RegExp): TagMatch | null {
  const match = pattern.exec(text.slice(from));
  if (!match) {
    return null;
  }
  const start = from + match.index;
  return { end: start + match[0].length, raw: match[0], start };
}

function isWhitespace(value: string | undefined): boolean {
  return value !== undefined && WHITESPACE_RE.test(value);
}

function isPotentialNamedTagPrefix(
  value: string,
  names: readonly string[],
  allowClosing: boolean
): boolean {
  if (!value.startsWith("<")) {
    return false;
  }

  let cursor = 1;
  while (isWhitespace(value[cursor])) {
    cursor += 1;
  }
  if (value[cursor] === "/") {
    if (!allowClosing) {
      return false;
    }
    cursor += 1;
    while (isWhitespace(value[cursor])) {
      cursor += 1;
    }
  }

  const remainder = value.slice(cursor).toLowerCase();
  return names.some((name) => {
    if (remainder.length <= name.length) {
      return name.startsWith(remainder);
    }
    if (!remainder.startsWith(name)) {
      return false;
    }
    for (const character of remainder.slice(name.length)) {
      if (!isWhitespace(character)) {
        return false;
      }
    }
    return true;
  });
}

function potentialOpenSuffixIndex(text: string): number | null {
  const candidateStart = text.lastIndexOf("<");
  return candidateStart >= 0 &&
    isPotentialNamedTagPrefix(
      text.slice(candidateStart),
      [TOOL_CALL_NAME],
      false
    )
    ? candidateStart
    : null;
}

function hasPotentialStructuralTagSuffix(text: string): boolean {
  const candidateStart = text.lastIndexOf("<");
  return (
    candidateStart >= 0 &&
    isPotentialNamedTagPrefix(
      text.slice(candidateStart),
      GLM5_STRUCTURAL_TAG_NAMES,
      true
    )
  );
}

function createCloseTagScanner(): CloseTagScanner {
  return {
    argValueDepth: 0,
    candidateStart: -1,
    closeCandidateCount: 0,
    cursor: 0,
    firstClose: null,
    nestedToolCallDepth: 0,
    nestedToolCallSeen: false,
    pendingClose: null,
  };
}

function hasStructuralRecovery(
  call: NonNullable<ReturnType<typeof parseGlm5CallBody>>
): boolean {
  return call.recoveries.some((code) => STRUCTURAL_RECOVERY_CODES.has(code));
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this incremental structural scanner keeps candidate selection on one linear pass.
function scanToolCallClose(
  call: ActiveCall,
  protocolOptions: ResolvedGlm5ProtocolOptions,
  tools: LanguageModelV4FunctionTool[]
): TagMatch | null {
  const { closeScanner: scanner } = call;
  while (scanner.cursor < call.body.length) {
    const index = scanner.cursor;
    const character = call.body[index] ?? "";
    scanner.cursor += 1;

    if (scanner.candidateStart < 0) {
      if (character === "<") {
        scanner.candidateStart = index;
      }
      continue;
    }
    if (character === "<") {
      scanner.candidateStart = index;
      continue;
    }
    if (character !== ">") {
      continue;
    }

    const start = scanner.candidateStart;
    scanner.candidateStart = -1;
    const raw = call.body.slice(start, scanner.cursor);
    const match = STREAM_STRUCTURAL_TAG_RE.exec(raw);
    if (!match) {
      continue;
    }
    const closing = match[1] === "/";
    const name = match[2]?.toLowerCase();

    if (name === "arg_value") {
      if (closing) {
        scanner.argValueDepth = Math.max(0, scanner.argValueDepth - 1);
        if (scanner.argValueDepth === 0) {
          scanner.firstClose = null;
          scanner.nestedToolCallDepth = 0;
          scanner.nestedToolCallSeen = false;
          scanner.pendingClose = null;
        }
      } else {
        scanner.argValueDepth += 1;
      }
      continue;
    }

    if (!closing) {
      scanner.nestedToolCallDepth += 1;
      scanner.nestedToolCallSeen = true;
      continue;
    }
    const close = { end: scanner.cursor, raw, start };
    scanner.closeCandidateCount += 1;
    scanner.firstClose ??= close;
    if (scanner.closeCandidateCount > MAX_GLM5_TOOL_CALL_CLOSE_CANDIDATES) {
      call.closeSelectionRejected = true;
      call.suppressRemainderResync = true;
      return close;
    }

    const body = call.body.slice(0, close.start);
    let parsed: ReturnType<typeof parseGlm5CallBody> = null;
    try {
      parsed = parseGlm5CallBody({
        body,
        complete: true,
        protocolOptions,
        tools,
      });
    } catch {
      parsed = null;
    }
    if (!parsed && hasExplicitlyClosedGlm5TaggedBody(body)) {
      return close;
    }
    if (parsed && !hasStructuralRecovery(parsed)) {
      return close;
    }
    if (parsed) {
      scanner.pendingClose ??= close;
    }
    if (scanner.nestedToolCallDepth > 0) {
      scanner.nestedToolCallDepth -= 1;
    }
  }
  return null;
}

function rawCall(activeCall: ActiveCall, closeTag = ""): string {
  return `${activeCall.openTag}${activeCall.body}${closeTag}`;
}

export function createGlm5StreamParser({
  tools,
  options,
  protocolOptions,
}: {
  tools: LanguageModelV4FunctionTool[];
  options?: ParserOptions;
  protocolOptions: ResolvedGlm5ProtocolOptions;
}): TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart> {
  let textBuffer = "";
  let activeCall: ActiveCall | null = null;
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

  const emitRawFallback = (controller: StreamController, raw: string) => {
    if (
      shouldEmitRawToolCallTextOnError(options) &&
      !toolCallTextHasPrototypeSensitiveKey(raw)
    ) {
      flushText(controller, raw);
    }
  };

  const reportFailure = (raw: string, call: ActiveCall, error?: unknown) => {
    options?.onError?.("Could not parse streaming GLM-5.2 tool call.", {
      dropReason: "malformed-glm5-tool-call",
      ...(error === undefined
        ? {}
        : { error: safeToolCallMetadataError(error, raw) }),
      toolCall: safeToolCallMetadataText(raw),
      toolCallId: call.id ?? undefined,
      toolName: call.toolName ?? undefined,
    });
  };

  const ensureToolInputStarted = (
    controller: StreamController,
    call: ActiveCall,
    toolName: string
  ) => {
    if (call.id || call.failed) {
      return;
    }
    flushText(controller);
    call.id = generateToolCallId();
    call.toolName = toolName;
    controller.enqueue({
      type: "tool-input-start",
      id: call.id,
      toolName,
    });
  };

  const closeToolInput = (controller: StreamController, call: ActiveCall) => {
    if (!(call.id && !call.inputEnded)) {
      return;
    }
    enqueueToolInputEnd({ controller, id: call.id });
    call.inputEnded = true;
  };

  const markCallFailed = (
    controller: StreamController,
    call: ActiveCall,
    raw: string,
    error?: unknown
  ) => {
    if (!call.failed) {
      reportFailure(raw, call, error);
      call.failed = true;
    }
    closeToolInput(controller, call);
  };

  const markCallOversized = (
    controller: StreamController,
    call: ActiveCall
  ) => {
    if (!call.failed) {
      options?.onError?.("Could not parse streaming GLM-5.2 tool call.", {
        bodyLengthLimit: MAX_GLM5_CALL_BODY_LENGTH,
        dropReason: "malformed-glm5-tool-call",
        toolCall: OVERSIZED_GLM5_TOOL_CALL_METADATA,
        toolCallId: call.id ?? undefined,
        toolName: call.toolName ?? undefined,
      });
      call.failed = true;
    }
    closeToolInput(controller, call);

    // An oversized argument can contain arbitrary literal close markers. Once
    // the hard limit is crossed there is no safe structural boundary at which
    // to resume, so poison the remainder of this model stream. Drop all large
    // retained strings immediately and never reconstruct a raw fallback.
    call.body = "";
    call.closeScanner = createCloseTagScanner();
    call.emittedInput = "";
    call.openTag = "";
    call.oversized = true;
    call.suppressRemainderResync = true;
    textBuffer = "";
    streamPoisoned = true;
  };

  const updateToolInputProgress = (
    controller: StreamController,
    call: ActiveCall
  ) => {
    if (
      call.failed ||
      call.markdownCodePrefixed ||
      call.closeScanner.firstClose ||
      call.body.length < call.nextProgressParseLength
    ) {
      return;
    }
    call.nextProgressParseLength =
      call.body.length === 0 ? 1 : call.body.length * 2;
    if (hasPotentialStructuralTagSuffix(call.body)) {
      return;
    }

    let snapshot: ReturnType<typeof parseGlm5CallBody>;
    try {
      snapshot = parseGlm5CallBody({
        body: call.body,
        complete: false,
        protocolOptions,
        tools,
      });
    } catch (error) {
      markCallFailed(controller, call, rawCall(call), error);
      return;
    }
    if (!snapshot) {
      return;
    }
    ensureToolInputStarted(controller, call, snapshot.toolName);
    if (!(call.id && call.toolName === snapshot.toolName)) {
      return;
    }
    try {
      const fullInput = stringifyGlm5CallInput(snapshot, tools);
      emitToolInputProgressDelta({
        controller,
        fullInput,
        id: call.id,
        state: call,
      });
    } catch (error) {
      markCallFailed(controller, call, rawCall(call), error);
    }
  };

  const finalizeExecutableCall = (
    controller: StreamController,
    call: ActiveCall,
    incomplete: boolean,
    raw: string
  ) => {
    if (call.failed) {
      emitRawFallback(controller, raw);
      return;
    }

    let snapshot: ReturnType<typeof parseGlm5CallBody>;
    try {
      snapshot = parseGlm5CallBody({
        body: call.body,
        complete: true,
        protocolOptions,
        tools,
      });
    } catch (error) {
      markCallFailed(controller, call, raw, error);
      emitRawFallback(controller, raw);
      return;
    }
    if (!snapshot) {
      markCallFailed(controller, call, raw);
      emitRawFallback(controller, raw);
      return;
    }
    ensureToolInputStarted(controller, call, snapshot.toolName);
    if (!(call.id && call.toolName === snapshot.toolName)) {
      markCallFailed(controller, call, raw);
      emitRawFallback(controller, raw);
      return;
    }

    try {
      const finalInput = stringifyGlm5CallInput(snapshot, tools);
      if (!finalInput.startsWith(call.emittedInput)) {
        options?.onError?.(
          "Final JSON does not extend emitted tool-input prefix",
          {
            dropReason: "non-monotonic-glm5-stream-input",
            emittedLength: call.emittedInput.length,
            finalLength: finalInput.length,
            toolCallId: call.id,
            toolName: call.toolName,
          }
        );
        call.failed = true;
        closeToolInput(controller, call);
        emitRawFallback(controller, raw);
        return;
      }
      if (finalInput === call.emittedInput) {
        enqueueToolInputEndAndCall({
          controller,
          id: call.id,
          input: finalInput,
          toolName: snapshot.toolName,
        });
        call.inputEnded = true;
      } else {
        emitFinalizedToolInputLifecycle({
          controller,
          finalInput,
          id: call.id,
          state: call,
          toolName: snapshot.toolName,
        });
        call.inputEnded = true;
      }
      const recoveryCodes = [
        ...snapshot.recoveries,
        ...(incomplete ? ["recovered-missing-tool-call-close"] : []),
      ];
      if (recoveryCodes.length > 0) {
        options?.onError?.("Recovered malformed streaming GLM-5.2 tool call.", {
          recoveryCodes,
          toolCall: safeToolCallMetadataText(raw),
          toolCallId: call.id,
          toolName: snapshot.toolName,
        });
      }
    } catch (error) {
      markCallFailed(controller, call, raw, error);
      emitRawFallback(controller, raw);
    }
  };

  const finalizeCall = (
    controller: StreamController,
    call: ActiveCall,
    closeTag: string,
    incomplete: boolean
  ) => {
    if (call.oversized) {
      return;
    }
    const raw = rawCall(call, closeTag);
    if (call.markdownCodePrefixed) {
      flushText(controller, raw);
      return;
    }
    finalizeExecutableCall(controller, call, incomplete, raw);
  };

  const flushSafeTextBuffer = (controller: StreamController) => {
    const potentialIndex = potentialOpenSuffixIndex(textBuffer);
    if (potentialIndex === null) {
      const bareCall = parseGlm5AnchoredBareToolCall({
        text: textBuffer,
        tools,
      });
      if (bareCall) {
        const id = generateToolCallId();
        flushText(controller);
        controller.enqueue({
          type: "tool-input-start",
          id,
          toolName: bareCall.toolName,
        });
        enqueueToolInputEndAndCall({
          controller,
          id,
          input: bareCall.input,
          toolName: bareCall.toolName,
        });
      } else {
        const trimmed = textBuffer.trimStart();
        if (
          tools.some(
            (tool) =>
              tool.name.startsWith(trimmed) ||
              trimmed.startsWith(`${tool.name}(`)
          ) &&
          !trimmed.includes("\n")
        ) {
          return;
        }
        flushText(controller, textBuffer);
      }
      textBuffer = "";
      return;
    }
    if (potentialIndex > 0) {
      flushText(controller, textBuffer.slice(0, potentialIndex));
      textBuffer = textBuffer.slice(potentialIndex);
    }
  };

  const queueRemainder = (call: ActiveCall, remainder: string) => {
    if (!call.suppressRemainderResync) {
      textBuffer = `${remainder}${textBuffer}`;
    }
  };

  const processActiveCall = (controller: StreamController): boolean => {
    const call = activeCall;
    if (!call || call.oversized) {
      return false;
    }
    const close = scanToolCallClose(call, protocolOptions, tools);
    if (!close) {
      if (textBuffer.length > 0) {
        markCallOversized(controller, call);
      } else {
        updateToolInputProgress(controller, call);
      }
      return false;
    }

    const remainder = call.body.slice(close.end);
    call.body = call.body.slice(0, close.start);
    if (call.closeSelectionRejected) {
      markCallFailed(controller, call, rawCall(call, close.raw));
    }
    finalizeCall(controller, call, close.raw, false);
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

      const open = findTag(textBuffer, 0, TOOL_CALL_OPEN_RE);
      if (!open) {
        flushSafeTextBuffer(controller);
        return;
      }
      const prefix = textBuffer.slice(0, open.start);
      if (prefix.length > 0) {
        flushText(controller, prefix);
      }
      const insideMarkdownCode =
        markdownCodeContextSuppressesToolCall(markdownContext);
      flushText(controller);
      const body = textBuffer.slice(
        open.end,
        open.end + MAX_GLM5_CALL_BODY_LENGTH
      );
      const remainderStart = open.end + body.length;
      activeCall = {
        body,
        closeSelectionRejected: false,
        closeScanner: createCloseTagScanner(),
        emittedInput: "",
        failed: false,
        id: null,
        inputEnded: false,
        markdownCodePrefixed: insideMarkdownCode,
        nextProgressParseLength: 0,
        openTag: open.raw,
        oversized: false,
        suppressRemainderResync: false,
        toolName: null,
      };
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
    const remainder = completedCall.body.slice(close.end);
    completedCall.body = completedCall.body.slice(0, close.start);
    finalizeCall(controller, completedCall, close.raw, false);
    activeCall = null;
    queueRemainder(completedCall, remainder);
    return true;
  };

  const finalizePending = (controller: StreamController) => {
    if (streamPoisoned) {
      if (activeCall) {
        closeToolInput(controller, activeCall);
      }
      activeCall = null;
      textBuffer = "";
      flushText(controller);
      return;
    }
    processBufferedText(controller);
    if (activeCall?.closeScanner.nestedToolCallSeen) {
      activeCall.suppressRemainderResync = true;
      markCallFailed(controller, activeCall, rawCall(activeCall));
    }
    while (finalizeDeferredClose(controller)) {
      processBufferedText(controller);
    }
    if (activeCall) {
      const call = activeCall;
      activeCall = null;
      if (protocolOptions.recoverIncompleteToolCalls) {
        finalizeCall(controller, call, "", true);
      } else {
        const raw = rawCall(call);
        markCallFailed(controller, call, raw);
        emitRawFallback(controller, raw);
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
            MAX_GLM5_CALL_BODY_LENGTH - activeCall.body.length
          );
          activeCall.body += part.delta.slice(0, retainedLength);
          textBuffer += part.delta.slice(retainedLength);
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
