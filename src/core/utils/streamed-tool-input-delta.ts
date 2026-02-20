import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

export interface EmittedToolInputState {
  emittedInput: string;
}

interface EmitToolInputDeltaBaseParams {
  controller: TransformStreamDefaultController<LanguageModelV3StreamPart>;
  id: string;
  state: EmittedToolInputState;
}

interface EmitPrefixDeltaParams extends EmitToolInputDeltaBaseParams {
  candidate: string;
}

interface EmitChunkedPrefixDeltaParams extends EmitPrefixDeltaParams {
  maxChunkChars?: number;
}

interface EmitFinalRemainderParams extends EmitToolInputDeltaBaseParams {
  finalFullJson: string;
  onMismatch?: (message: string, metadata?: Record<string, unknown>) => void;
}

function emitDelta({
  controller,
  id,
  state,
  nextInput,
}: EmitToolInputDeltaBaseParams & {
  nextInput: string;
}): boolean {
  if (!nextInput.startsWith(state.emittedInput)) {
    return false;
  }

  const delta = nextInput.slice(state.emittedInput.length);
  if (delta.length === 0) {
    return false;
  }

  controller.enqueue({
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
  return emitDelta({
    ...params,
    nextInput: params.candidate,
  });
}

const DEFAULT_TOOL_INPUT_DELTA_CHUNK_CHARS = 512;

export function emitChunkedPrefixDelta(
  params: EmitChunkedPrefixDeltaParams
): boolean {
  const { maxChunkChars = DEFAULT_TOOL_INPUT_DELTA_CHUNK_CHARS } = params;
  if (maxChunkChars <= 0) {
    return emitPrefixDelta(params);
  }

  const growth = params.candidate.length - params.state.emittedInput.length;
  if (growth <= 0) {
    return false;
  }

  if (growth <= maxChunkChars) {
    return emitPrefixDelta(params);
  }

  let emittedAny = false;
  let cursor = params.state.emittedInput.length + maxChunkChars;
  while (cursor < params.candidate.length) {
    const didEmit = emitPrefixDelta({
      controller: params.controller,
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
    emitPrefixDelta({
      controller: params.controller,
      id: params.id,
      state: params.state,
      candidate: params.candidate,
    }) || emittedAny
  );
}

export function emitFinalRemainder(params: EmitFinalRemainderParams): boolean {
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
