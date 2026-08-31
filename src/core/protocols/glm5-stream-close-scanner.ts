import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import {
  hasExplicitlyClosedGlm5TaggedBody,
  parseGlm5CallBody,
  type ResolvedGlm5ProtocolOptions,
} from "./glm5-call-parsing";
import { materializeGlm5StreamBody } from "./glm5-stream-body";
import type {
  ActiveGlm5Call,
  Glm5CloseTagScanner,
  Glm5TagMatch,
} from "./glm5-stream-state";

export type { ActiveGlm5Call } from "./glm5-stream-state";

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
const WHITESPACE_RE = /\s/;

export function findGlm5ToolCallOpen(
  text: string,
  from: number
): Glm5TagMatch | null {
  const match = TOOL_CALL_OPEN_RE.exec(text.slice(from));
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

export function potentialGlm5OpenSuffixIndex(text: string): number | null {
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

export function hasPotentialGlm5StructuralTagSuffix(text: string): boolean {
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

export function createGlm5CloseTagScanner(): Glm5CloseTagScanner {
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
export function scanGlm5ToolCallClose(
  call: ActiveGlm5Call,
  protocolOptions: ResolvedGlm5ProtocolOptions,
  tools: LanguageModelV4FunctionTool[]
): Glm5TagMatch | null {
  const { closeScanner: scanner } = call;
  const materializedBody = materializeGlm5StreamBody(call.body);
  while (scanner.cursor < materializedBody.length) {
    const index = scanner.cursor;
    const character = materializedBody[index] ?? "";
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
    const raw = materializedBody.slice(start, scanner.cursor);
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

    const body = materializedBody.slice(0, close.start);
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

export function materializeRawGlm5Call(
  call: ActiveGlm5Call,
  closeTag = ""
): string {
  return `${call.openTag}${materializeGlm5StreamBody(call.body)}${closeTag}`;
}
