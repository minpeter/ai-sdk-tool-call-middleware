import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import {
  toolCallInputHasPrototypeSensitiveKey,
  toolCallTextHasPrototypeSensitiveKey,
} from "./prototype-sensitive-keys";
import {
  type EmittedToolInputState,
  emitChunkedPrefixDelta,
  emitChunkedPrefixDeltaWithEnqueue,
  emitFinalRemainder,
  emitFinalRemainderWithEnqueue,
  toIncompleteJsonPrefix,
} from "./streamed-tool-input-delta";
import { coerceToolCallInput } from "./tool-call-coercion";

type StreamController =
  TransformStreamDefaultController<LanguageModelV4StreamPart>;
type EnqueueStreamPart = (part: LanguageModelV4StreamPart) => void;

interface RawFallbackOptions {
  emitRawToolCallTextOnError?: boolean;
}

type OnMismatch = (message: string, metadata?: Record<string, unknown>) => void;

export class PrototypeSensitiveToolCallInputError extends Error {
  readonly name = "PrototypeSensitiveToolCallInputError";

  constructor() {
    super("Tool call arguments contain prototype-sensitive keys");
  }
}

export function isPrototypeSensitiveToolCallInputError(
  error: unknown
): error is PrototypeSensitiveToolCallInputError {
  return error instanceof PrototypeSensitiveToolCallInputError;
}

export function stringifyToolInputWithSchema(options: {
  toolName: string;
  args: unknown;
  tools: LanguageModelV4FunctionTool[];
  fallback?: (args: unknown) => string;
}): string {
  if (toolCallInputHasPrototypeSensitiveKey(options.args)) {
    throw new PrototypeSensitiveToolCallInputError();
  }

  const coerced = coerceToolCallInput(
    options.toolName,
    options.args,
    options.tools
  );
  if (coerced !== undefined) {
    return coerced;
  }

  if (options.fallback) {
    return options.fallback(options.args);
  }

  return JSON.stringify(options.args ?? {});
}

export function emitToolInputProgressDelta(options: {
  controller: StreamController;
  id: string;
  state: EmittedToolInputState;
  fullInput: string;
  mode?: "full-json" | "incomplete-json-prefix";
}): boolean {
  const mode = options.mode ?? "incomplete-json-prefix";
  const candidate =
    mode === "full-json"
      ? options.fullInput
      : toIncompleteJsonPrefix(options.fullInput);

  return emitChunkedPrefixDelta({
    controller: options.controller,
    id: options.id,
    state: options.state,
    candidate,
  });
}

export function emitBufferedToolInputProgressDelta(options: {
  enqueue: EnqueueStreamPart;
  id: string;
  state: EmittedToolInputState;
  fullInput: string;
  mode?: "full-json" | "incomplete-json-prefix";
}): boolean {
  const mode = options.mode ?? "incomplete-json-prefix";
  const candidate =
    mode === "full-json"
      ? options.fullInput
      : toIncompleteJsonPrefix(options.fullInput);

  return emitChunkedPrefixDeltaWithEnqueue({
    enqueue: options.enqueue,
    id: options.id,
    state: options.state,
    candidate,
  });
}

export function enqueueToolInputEndAndCall(options: {
  controller: StreamController;
  id: string;
  toolName: string;
  input: string;
}): void {
  enqueueToolInputEnd({
    controller: options.controller,
    id: options.id,
  });
  options.controller.enqueue({
    type: "tool-call",
    toolCallId: options.id,
    toolName: options.toolName,
    input: options.input,
  });
}

export function enqueueToolInputEnd(options: {
  controller: StreamController;
  id: string;
}): void {
  options.controller.enqueue({
    type: "tool-input-end",
    id: options.id,
  });
}

export function emitFailedToolInputLifecycle(options: {
  controller: StreamController;
  id: string;
  emitRawToolCallTextOnError: boolean;
  emitRawText?: (rawText: string) => void;
  endInput?: boolean;
  rawToolCallText?: string | null;
}): void {
  if (options.endInput !== false) {
    enqueueToolInputEnd({
      controller: options.controller,
      id: options.id,
    });
  }

  if (
    options.emitRawToolCallTextOnError &&
    typeof options.rawToolCallText === "string" &&
    options.rawToolCallText.length > 0 &&
    !toolCallTextHasPrototypeSensitiveKey(options.rawToolCallText)
  ) {
    options.emitRawText?.(options.rawToolCallText);
  }
}

export function emitFailedBufferedToolInputLifecycle(options: {
  bufferedParts: LanguageModelV4StreamPart[];
  controller: StreamController;
  id: string;
  emitRawToolCallTextOnError: boolean;
  endInputOnError?: boolean;
  emitRawText?: (rawText: string) => void;
  hideBufferedInputOnError?: boolean;
  rawToolCallText?: string | null;
}): void {
  const hidesBufferedInput =
    options.hideBufferedInputOnError === true ||
    (typeof options.rawToolCallText === "string" &&
      toolCallTextHasPrototypeSensitiveKey(options.rawToolCallText));

  if (hidesBufferedInput) {
    options.bufferedParts.length = 0;
    emitFailedToolInputLifecycle({
      controller: options.controller,
      id: options.id,
      endInput: options.endInputOnError === true,
      emitRawToolCallTextOnError: false,
      rawToolCallText: options.rawToolCallText,
      emitRawText: options.emitRawText,
    });
    return;
  }

  const hadBufferedInput =
    options.bufferedParts.length > 0 || options.endInputOnError === true;
  for (const part of options.bufferedParts) {
    options.controller.enqueue(part);
  }
  options.bufferedParts.length = 0;
  emitFailedToolInputLifecycle({
    controller: options.controller,
    id: options.id,
    endInput: hadBufferedInput,
    emitRawToolCallTextOnError: options.emitRawToolCallTextOnError,
    rawToolCallText: options.rawToolCallText,
    emitRawText: options.emitRawText,
  });
}

export function emitFinalizedToolInputLifecycle(options: {
  controller: StreamController;
  id: string;
  state: EmittedToolInputState;
  toolName: string;
  finalInput: string;
  onMismatch?: OnMismatch;
}): void {
  emitFinalRemainder({
    controller: options.controller,
    id: options.id,
    state: options.state,
    finalFullJson: options.finalInput,
    onMismatch: options.onMismatch,
  });

  enqueueToolInputEndAndCall({
    controller: options.controller,
    id: options.id,
    toolName: options.toolName,
    input: options.finalInput,
  });
}

export function emitFinalizedBufferedToolInputLifecycle(options: {
  bufferedParts: LanguageModelV4StreamPart[];
  controller: StreamController;
  id: string;
  state: EmittedToolInputState;
  toolName: string;
  finalInput: string;
  onMismatch?: OnMismatch;
}): void {
  const enqueueBufferedPart = (part: LanguageModelV4StreamPart) => {
    options.bufferedParts.push(part);
  };
  emitFinalRemainderWithEnqueue({
    enqueue: enqueueBufferedPart,
    id: options.id,
    state: options.state,
    finalFullJson: options.finalInput,
    onMismatch: options.onMismatch,
  });

  options.bufferedParts.push({
    type: "tool-input-end",
    id: options.id,
  });
  for (const part of options.bufferedParts) {
    options.controller.enqueue(part);
  }
  options.bufferedParts.length = 0;
  options.controller.enqueue({
    type: "tool-call",
    toolCallId: options.id,
    toolName: options.toolName,
    input: options.finalInput,
  });
}

export function shouldEmitRawToolCallTextOnError(
  options?: RawFallbackOptions
): boolean {
  return options?.emitRawToolCallTextOnError === true;
}
