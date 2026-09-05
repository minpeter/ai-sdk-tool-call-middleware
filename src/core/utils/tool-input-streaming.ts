import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { RxmlValue } from "../../rxml/builders/stringify";
import type { OnErrorFn } from "./on-error";
import { toolCallTextHasPrototypeSensitiveKey } from "./prototype-sensitive-keys";
import {
  type EmittedToolInputState,
  emitChunkedPrefixDeltaWithEnqueue,
  emitFinalRemainder,
  emitFinalRemainderWithEnqueue,
  toIncompleteJsonPrefix,
} from "./streamed-tool-input-delta";
import {
  coerceToolCallInput,
  toolCallInputHasSchemaAwarePrototypeSensitiveValue,
} from "./tool-call-coercion";

type StreamController =
  TransformStreamDefaultController<LanguageModelV4StreamPart>;
type EnqueueStreamPart = (part: LanguageModelV4StreamPart) => void;
type CompleteToolCall = Extract<
  LanguageModelV4StreamPart,
  { type: "tool-call" }
>;

interface RawFallbackOptions {
  emitRawToolCallTextOnError?: boolean;
}

type OnMismatch = OnErrorFn;

export class PrototypeSensitiveToolCallInputError extends Error {
  readonly name = "PrototypeSensitiveToolCallInputError";

  constructor() {
    super("Tool call arguments contain prototype-sensitive keys");
  }
}

export function isPrototypeSensitiveToolCallInputError(
  error: Error
): error is PrototypeSensitiveToolCallInputError {
  return error instanceof PrototypeSensitiveToolCallInputError;
}

export function stringifyToolInputWithSchema(options: {
  toolName: string;
  args: RxmlValue;
  tools: LanguageModelV4FunctionTool[];
  fallback?: (args: RxmlValue) => string;
}): string {
  const schema = options.tools.find(
    (tool) => tool.name === options.toolName
  )?.inputSchema;
  if (
    toolCallInputHasSchemaAwarePrototypeSensitiveValue(options.args, schema)
  ) {
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

interface ToolInputProgressOptions {
  readonly fullInput: string;
  readonly id: string;
  readonly mode?: "full-json" | "incomplete-json-prefix";
  readonly state: EmittedToolInputState;
}

function emitToolInputProgressDeltaWithEnqueue(
  options: ToolInputProgressOptions & { readonly enqueue: EnqueueStreamPart }
): boolean {
  const candidate =
    options.mode === "full-json"
      ? options.fullInput
      : toIncompleteJsonPrefix(options.fullInput);

  return emitChunkedPrefixDeltaWithEnqueue({
    enqueue: options.enqueue,
    id: options.id,
    state: options.state,
    candidate,
  });
}

export function emitToolInputProgressDelta(
  options: ToolInputProgressOptions & { readonly controller: StreamController }
): boolean {
  return emitToolInputProgressDeltaWithEnqueue({
    ...options,
    enqueue: (part) => options.controller.enqueue(part),
  });
}

export function emitBufferedToolInputProgressDelta(
  options: ToolInputProgressOptions & { readonly enqueue: EnqueueStreamPart }
): boolean {
  return emitToolInputProgressDeltaWithEnqueue(options);
}

function enqueueToolInputEndAndCallWithEnqueue(
  enqueue: EnqueueStreamPart,
  call: CompleteToolCall
): void {
  enqueue({ type: "tool-input-end", id: call.toolCallId });
  enqueue(call);
}

export function enqueueCompleteToolCallLifecycle(options: {
  readonly call: CompleteToolCall;
  readonly controller: StreamController;
  readonly emitEmptyInputDelta?: boolean;
}): void {
  const { call, controller } = options;
  controller.enqueue({
    type: "tool-input-start",
    id: call.toolCallId,
    toolName: call.toolName,
  });
  if (call.input.length > 0 || options.emitEmptyInputDelta === true) {
    controller.enqueue({
      type: "tool-input-delta",
      id: call.toolCallId,
      delta: call.input,
    });
  }
  enqueueToolInputEndAndCallWithEnqueue(
    (part) => controller.enqueue(part),
    call
  );
}

export function enqueueToolInputEndAndCall(options: {
  controller: StreamController;
  id: string;
  toolName: string;
  input: string;
}): void {
  enqueueToolInputEndAndCallWithEnqueue(
    (part) => options.controller.enqueue(part),
    {
      type: "tool-call",
      toolCallId: options.id,
      toolName: options.toolName,
      input: options.input,
    }
  );
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

  enqueueToolInputEndAndCallWithEnqueue(enqueueBufferedPart, {
    type: "tool-call",
    toolCallId: options.id,
    toolName: options.toolName,
    input: options.finalInput,
  });
  for (const part of options.bufferedParts) {
    options.controller.enqueue(part);
  }
  options.bufferedParts.length = 0;
}

export function shouldEmitRawToolCallTextOnError(
  options?: RawFallbackOptions
): boolean {
  return options?.emitRawToolCallTextOnError === true;
}
