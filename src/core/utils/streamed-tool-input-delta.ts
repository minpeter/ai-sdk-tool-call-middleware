import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

interface EmittedToolInputState {
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

interface EmitFinalRemainderParams extends EmitToolInputDeltaBaseParams {
  finalFullJson: string;
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

export function toIncompleteJsonPrefix(fullJson: string): string {
  let prefix = fullJson;

  while (prefix.endsWith("}") || prefix.endsWith("]")) {
    prefix = prefix.slice(0, -1);
  }

  if (prefix.endsWith('"')) {
    prefix = prefix.slice(0, -1);
  }

  if (prefix.length === 0) {
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

export function emitFinalRemainder(params: EmitFinalRemainderParams): boolean {
  return emitDelta({
    ...params,
    nextInput: params.finalFullJson,
  });
}
