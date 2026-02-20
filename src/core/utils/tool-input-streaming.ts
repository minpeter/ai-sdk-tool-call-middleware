import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import {
  type EmittedToolInputState,
  emitChunkedPrefixDelta,
  emitFinalRemainder,
  toIncompleteJsonPrefix,
} from "./streamed-tool-input-delta";
import { coerceToolCallInput } from "./tool-call-coercion";

type StreamController =
  TransformStreamDefaultController<LanguageModelV3StreamPart>;

interface RawFallbackOptions {
  emitRawToolCallTextOnError?: boolean;
}

type OnMismatch = (message: string, metadata?: Record<string, unknown>) => void;

export function stringifyToolInputWithSchema(options: {
  toolName: string;
  args: unknown;
  tools: LanguageModelV3FunctionTool[];
  fallback?: (args: unknown) => string;
}): string {
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
    options.rawToolCallText.length > 0
  ) {
    options.emitRawText?.(options.rawToolCallText);
  }
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

export function shouldEmitRawToolCallTextOnError(
  options?: RawFallbackOptions
): boolean {
  return options?.emitRawToolCallTextOnError === true;
}
