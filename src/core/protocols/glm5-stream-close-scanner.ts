import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import {
  hasExplicitlyClosedGlm5TaggedBody,
  parseGlm5CallBody,
  type ResolvedGlm5ProtocolOptions,
} from "./glm5-call-parsing";
import {
  appendGlm5StreamBody,
  materializeGlm5StreamBody,
} from "./glm5-stream-body";
import type {
  ActiveGlm5Call,
  Glm5CloseTagScanner,
  Glm5TagMatch,
} from "./glm5-stream-state";

export type { ActiveGlm5Call } from "./glm5-stream-state";

const TOOL_CALL_OPEN_RE = /<\s*tool_call\s*>/i;
const TOOL_CALL_CLOSE_AT_START_RE = /^<\s*\/\s*tool_call\s*>/i;
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

export function findGlm5ToolCallCloseAtStart(
  text: string
): Glm5TagMatch | null {
  const match = TOOL_CALL_CLOSE_AT_START_RE.exec(text);
  return match ? { end: match[0].length, raw: match[0], start: 0 } : null;
}

export function isPotentialGlm5ToolCallClosePrefix(text: string): boolean {
  if (!text.startsWith("<")) {
    return false;
  }
  let cursor = 1;
  while (isWhitespace(text[cursor])) {
    cursor += 1;
  }
  return (
    (text[cursor] === undefined || text[cursor] === "/") &&
    isPotentialNamedTagPrefix(text, [TOOL_CALL_NAME], true)
  );
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

export function createGlm5CloseTagScanner(
  initialText = ""
): Glm5CloseTagScanner {
  const scanner = {
    argValueDepth: 0,
    candidateParts: null,
    candidateStart: -1,
    closeCandidateCount: 0,
    cursor: 0,
    firstClose: null,
    nestedToolCallDepth: 0,
    nestedToolCallSeen: false,
    pendingClose: null,
    pendingChunks: [],
  };
  queueGlm5CloseScannerText(scanner, initialText);
  return scanner;
}

export function appendGlm5ScannedStreamBody(
  call: ActiveGlm5Call,
  text: string
): void {
  appendGlm5StreamBody(call.body, text);
  queueGlm5CloseScannerText(call.closeScanner, text);
}

export function queueGlm5CloseScannerText(
  scanner: Glm5CloseTagScanner,
  text: string
): void {
  if (text.length > 0) {
    scanner.pendingChunks.push(text);
  }
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
  while (scanner.pendingChunks.length > 0) {
    const chunk = scanner.pendingChunks.shift() ?? "";
    let offset = 0;
    while (offset < chunk.length) {
      const character = chunk[offset] ?? "";
      offset += 1;
      const index = scanner.cursor;
      scanner.cursor += 1;

      if (scanner.candidateStart < 0) {
        if (character === "<") {
          scanner.candidateParts = ["<"];
          scanner.candidateStart = index;
        }
        continue;
      }
      if (character === "<") {
        scanner.candidateParts = ["<"];
        scanner.candidateStart = index;
        continue;
      }
      scanner.candidateParts?.push(character);
      if (character !== ">") {
        continue;
      }

      const start = scanner.candidateStart;
      scanner.candidateStart = -1;
      const raw = scanner.candidateParts?.join("") ?? "";
      scanner.candidateParts = null;
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

      const body = materializeGlm5StreamBody(call.body).slice(0, close.start);
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
  }
  return null;
}

export function materializeRawGlm5Call(
  call: ActiveGlm5Call,
  closeTag = ""
): string {
  return `${call.openTag}${materializeGlm5StreamBody(call.body)}${closeTag}`;
}
