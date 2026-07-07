import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";

export interface EmittedToolInputState {
  emittedInput: string;
}

type EnqueueStreamPart = (part: LanguageModelV4StreamPart) => void;

interface EmitToolInputDeltaBaseParams {
  controller: TransformStreamDefaultController<LanguageModelV4StreamPart>;
  id: string;
  state: EmittedToolInputState;
}

interface EmitToolInputDeltaEnqueueParams {
  enqueue: EnqueueStreamPart;
  id: string;
  state: EmittedToolInputState;
}

interface EmitPrefixDeltaParams extends EmitToolInputDeltaBaseParams {
  candidate: string;
}

interface EmitPrefixDeltaWithEnqueueParams
  extends EmitToolInputDeltaEnqueueParams {
  candidate: string;
}

interface EmitChunkedPrefixDeltaParams extends EmitPrefixDeltaParams {
  maxChunkChars?: number;
}

interface EmitChunkedPrefixDeltaWithEnqueueParams
  extends EmitPrefixDeltaWithEnqueueParams {
  maxChunkChars?: number;
}

interface EmitFinalRemainderParams extends EmitToolInputDeltaBaseParams {
  finalFullJson: string;
  onMismatch?: (message: string, metadata?: Record<string, unknown>) => void;
}

interface EmitFinalRemainderWithEnqueueParams
  extends EmitToolInputDeltaEnqueueParams {
  finalFullJson: string;
  onMismatch?: (message: string, metadata?: Record<string, unknown>) => void;
}

function emitDelta({
  enqueue,
  id,
  state,
  nextInput,
}: EmitToolInputDeltaEnqueueParams & {
  nextInput: string;
}): boolean {
  if (!nextInput.startsWith(state.emittedInput)) {
    return false;
  }

  const delta = nextInput.slice(state.emittedInput.length);
  if (delta.length === 0) {
    return false;
  }

  enqueue({
    type: "tool-input-delta",
    id,
    delta,
  });
  state.emittedInput = nextInput;
  return true;
}

/**
 * Converts a complete JSON string to an incomplete prefix suitable for streaming.
 * Handles object, array, and string root types correctly.
 */
export function toIncompleteJsonPrefix(fullJson: string): string {
  const trimmed = fullJson.trim();
  let prefix = trimmed;

  while (prefix.endsWith("}") || prefix.endsWith("]")) {
    prefix = prefix.slice(0, -1);
  }

  prefix = prefix.trimEnd();

  if (prefix.endsWith('"')) {
    prefix = prefix.slice(0, -1);
  }

  if (prefix.length === 0) {
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      return trimmed.startsWith("{") ? "{" : "[";
    }
    if (trimmed.startsWith("]")) {
      return "[";
    }
    if (trimmed.startsWith("}")) {
      return "{";
    }
    if (trimmed.startsWith('"')) {
      return '"';
    }
    return "{";
  }

  return prefix;
}

export function emitPrefixDelta(params: EmitPrefixDeltaParams): boolean {
  return emitPrefixDeltaWithEnqueue({
    id: params.id,
    state: params.state,
    candidate: params.candidate,
    enqueue: (part) => {
      params.controller.enqueue(part);
    },
  });
}

export function emitPrefixDeltaWithEnqueue(
  params: EmitPrefixDeltaWithEnqueueParams
): boolean {
  return emitDelta({
    ...params,
    nextInput: params.candidate,
  });
}

const DEFAULT_TOOL_INPUT_DELTA_CHUNK_CHARS = 512;

export function emitChunkedPrefixDelta(
  params: EmitChunkedPrefixDeltaParams
): boolean {
  return emitChunkedPrefixDeltaWithEnqueue({
    id: params.id,
    state: params.state,
    candidate: params.candidate,
    maxChunkChars: params.maxChunkChars,
    enqueue: (part) => {
      params.controller.enqueue(part);
    },
  });
}

export function emitChunkedPrefixDeltaWithEnqueue(
  params: EmitChunkedPrefixDeltaWithEnqueueParams
): boolean {
  const { maxChunkChars = DEFAULT_TOOL_INPUT_DELTA_CHUNK_CHARS } = params;
  if (maxChunkChars <= 0) {
    return emitPrefixDeltaWithEnqueue(params);
  }

  const growth = params.candidate.length - params.state.emittedInput.length;
  if (growth <= 0) {
    return false;
  }

  if (growth <= maxChunkChars) {
    return emitPrefixDeltaWithEnqueue(params);
  }

  let emittedAny = false;
  let cursor = params.state.emittedInput.length + maxChunkChars;
  while (cursor < params.candidate.length) {
    const didEmit = emitPrefixDeltaWithEnqueue({
      enqueue: params.enqueue,
      id: params.id,
      state: params.state,
      candidate: params.candidate.slice(0, cursor),
    });
    if (!didEmit) {
      return emittedAny;
    }
    emittedAny = true;
    cursor += maxChunkChars;
  }

  return (
    emitPrefixDeltaWithEnqueue({
      enqueue: params.enqueue,
      id: params.id,
      state: params.state,
      candidate: params.candidate,
    }) || emittedAny
  );
}

export function emitFinalRemainder(params: EmitFinalRemainderParams): boolean {
  return emitFinalRemainderWithEnqueue({
    id: params.id,
    state: params.state,
    finalFullJson: params.finalFullJson,
    onMismatch: params.onMismatch,
    enqueue: (part) => {
      params.controller.enqueue(part);
    },
  });
}

export function emitFinalRemainderWithEnqueue(
  params: EmitFinalRemainderWithEnqueueParams
): boolean {
  const result = emitDelta({
    ...params,
    nextInput: params.finalFullJson,
  });

  if (!result && params.state.emittedInput.length > 0) {
    params.onMismatch?.(
      "Final JSON does not extend emitted tool-input prefix",
      {
        emittedLength: params.state.emittedInput.length,
        finalLength: params.finalFullJson.length,
      }
    );
  }

  return result;
}
