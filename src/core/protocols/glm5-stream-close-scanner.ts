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
const NAMED_TAG_PREFIX_RE = /^<\s*(\/?)\s*(\S*)\s*$/;

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

function isPotentialNamedTagPrefix(
  value: string,
  names: readonly string[],
  allowClosing: boolean
): boolean {
  const match = NAMED_TAG_PREFIX_RE.exec(value);
  if (!match || (match[1] === "/" && !allowClosing)) {
    return false;
  }
  const remainder = match[2]?.toLowerCase() ?? "";
  return names.some((name) => name.startsWith(remainder));
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

type ScannedStructuralTag = Glm5TagMatch & {
  readonly closing: boolean;
  readonly name: "arg_value" | "tool_call";
};
interface CloseCandidateOptions {
  readonly call: ActiveGlm5Call;
  readonly protocolOptions: ResolvedGlm5ProtocolOptions;
  readonly tag: ScannedStructuralTag;
  readonly tools: LanguageModelV4FunctionTool[];
}

function finishStructuralTag(
  scanner: Glm5CloseTagScanner,
  chunk: string,
  offset: number
): ScannedStructuralTag | null {
  const start = scanner.candidateStart;
  scanner.candidateStart = -1;
  const raw = scanner.candidateParts?.join("") ?? "";
  scanner.candidateParts = null;
  const match = STREAM_STRUCTURAL_TAG_RE.exec(raw);
  const name = match?.[2]?.toLowerCase();
  if (!(name === "arg_value" || name === "tool_call")) {
    return null;
  }
  const remainder = chunk.slice(offset + 1);
  if (remainder.length > 0) {
    scanner.pendingChunks.unshift(remainder);
  }
  return {
    closing: match?.[1] === "/",
    end: scanner.cursor,
    name,
    raw,
    start,
  };
}

function nextStructuralTag(
  scanner: Glm5CloseTagScanner
): ScannedStructuralTag | null {
  while (scanner.pendingChunks.length > 0) {
    const chunk = scanner.pendingChunks.shift() ?? "";
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const character = chunk[offset] ?? "";
      const index = scanner.cursor;
      scanner.cursor += 1;

      if (character === "<") {
        scanner.candidateParts = ["<"];
        scanner.candidateStart = index;
        continue;
      }
      if (scanner.candidateStart < 0) {
        continue;
      }
      scanner.candidateParts?.push(character);
      if (character !== ">") {
        continue;
      }

      const tag = finishStructuralTag(scanner, chunk, offset);
      if (tag) {
        return tag;
      }
    }
  }
  return null;
}

function consumeArgValueTag(
  scanner: Glm5CloseTagScanner,
  tag: ScannedStructuralTag
): boolean {
  if (tag.name !== "arg_value") {
    return false;
  }
  if (!tag.closing) {
    scanner.argValueDepth += 1;
    return true;
  }
  scanner.argValueDepth = Math.max(0, scanner.argValueDepth - 1);
  if (scanner.argValueDepth === 0) {
    scanner.firstClose = null;
    scanner.nestedToolCallDepth = 0;
    scanner.nestedToolCallSeen = false;
    scanner.pendingClose = null;
  }
  return true;
}

function considerStructuralTag({
  call,
  protocolOptions,
  tag,
  tools,
}: CloseCandidateOptions): Glm5TagMatch | null {
  const { closeScanner: scanner } = call;
  if (consumeArgValueTag(scanner, tag)) {
    return null;
  }
  if (!tag.closing) {
    if (scanner.firstClose && scanner.argValueDepth === 0) {
      return scanner.firstClose;
    }
    scanner.nestedToolCallDepth += 1;
    scanner.nestedToolCallSeen = true;
    return null;
  }

  const close = { end: tag.end, raw: tag.raw, start: tag.start };
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
  if (
    parsed &&
    !parsed.recoveries.some((code) => STRUCTURAL_RECOVERY_CODES.has(code))
  ) {
    return close;
  }
  if (parsed) {
    scanner.pendingClose ??= close;
  }
  if (scanner.nestedToolCallDepth > 0) {
    scanner.nestedToolCallDepth -= 1;
  }
  return null;
}

export function scanGlm5ToolCallClose(
  call: ActiveGlm5Call,
  protocolOptions: ResolvedGlm5ProtocolOptions,
  tools: LanguageModelV4FunctionTool[]
): Glm5TagMatch | null {
  let tag = nextStructuralTag(call.closeScanner);
  while (tag) {
    const close = considerStructuralTag({ call, protocolOptions, tag, tools });
    if (close) {
      return close;
    }
    tag = nextStructuralTag(call.closeScanner);
  }
  return null;
}

export function materializeRawGlm5Call(
  call: ActiveGlm5Call,
  closeTag = ""
): string {
  return `${call.openTag}${materializeGlm5StreamBody(call.body)}${closeTag}`;
}
