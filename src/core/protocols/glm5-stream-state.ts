import type { Glm5StreamBody } from "./glm5-stream-body";

export interface Glm5TagMatch {
  end: number;
  raw: string;
  start: number;
}

export interface Glm5CloseTagScanner {
  argValueDepth: number;
  candidateStart: number;
  closeCandidateCount: number;
  cursor: number;
  firstClose: Glm5TagMatch | null;
  nestedToolCallDepth: number;
  nestedToolCallSeen: boolean;
  pendingClose: Glm5TagMatch | null;
}

export interface ActiveGlm5Call {
  body: Glm5StreamBody;
  closeScanner: Glm5CloseTagScanner;
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

export function createActiveGlm5Call({
  body,
  closeScanner,
  markdownCodePrefixed,
  openTag,
}: {
  body: Glm5StreamBody;
  closeScanner: Glm5CloseTagScanner;
  markdownCodePrefixed: boolean;
  openTag: string;
}): ActiveGlm5Call {
  return {
    body,
    closeSelectionRejected: false,
    closeScanner,
    emittedInput: "",
    failed: false,
    id: null,
    inputEnded: false,
    markdownCodePrefixed,
    nextProgressParseLength: 0,
    openTag,
    oversized: false,
    suppressRemainderResync: false,
    toolName: null,
  };
}
