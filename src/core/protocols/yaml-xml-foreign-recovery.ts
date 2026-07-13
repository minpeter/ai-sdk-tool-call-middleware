import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { recoverToolCallFromJsonCandidates } from "../utils/generated-text-json-recovery";
import { addTextSegment } from "../utils/protocol-utils";
import { toolCallTextHasPrototypeSensitiveKey } from "../utils/prototype-sensitive-keys";
import { NAME_CHAR_RE, WHITESPACE_REGEX } from "../utils/regex-constants";

export interface YamlXmlProtocolOptions {
  /**
   * Whether to include a system prompt example showing YAML multiline syntax.
   * @default true
   */
  includeMultilineExample?: boolean;
}

const FOREIGN_SALVAGE_MARKUP_ONLY_RE = /^\s*(?:<[^<>\n]*>\s*)*$/;

const FOREIGN_TOOL_CALL_BLOCK_RE =
  /<tool_call\b[^>]*>[\s\S]*?(?:<\/tool_call\s*>|$)/i;
export const FOREIGN_TOOL_CALL_CLOSE_RE = /<\/tool_call\s*>/i;
const FOREIGN_TOOL_CALL_OPEN_MARKER = "<tool_call";

export type ForeignToolCallPart = Extract<
  LanguageModelV4Content,
  { type: "tool-call" }
>;

function isForeignToolCallOpenAt(lower: string, start: number): boolean {
  const afterMarker = lower[start + FOREIGN_TOOL_CALL_OPEN_MARKER.length] ?? "";
  return !(afterMarker && NAME_CHAR_RE.test(afterMarker));
}

export function findForeignToolCallOpenStart(lower: string): number {
  let searchIndex = 0;
  while (searchIndex < lower.length) {
    const start = lower.indexOf(FOREIGN_TOOL_CALL_OPEN_MARKER, searchIndex);
    if (start === -1) {
      return -1;
    }
    if (isForeignToolCallOpenAt(lower, start)) {
      return start;
    }
    searchIndex = start + FOREIGN_TOOL_CALL_OPEN_MARKER.length;
  }
  return -1;
}

function skipWhitespaceInLowercaseText(lower: string, start: number): number {
  let cursor = start;
  while (cursor < lower.length && WHITESPACE_REGEX.test(lower[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}

function getForeignToolCallOpenHoldStart(
  buffer: string,
  lower: string,
  start: number
): number | null {
  if (!isForeignToolCallOpenAt(lower, start)) {
    return null;
  }
  const tagEnd = lower.indexOf(
    ">",
    start + FOREIGN_TOOL_CALL_OPEN_MARKER.length
  );
  if (tagEnd === -1) {
    return start;
  }
  const payloadStart = skipWhitespaceInLowercaseText(lower, tagEnd + 1);
  if (payloadStart >= lower.length) {
    return start;
  }
  const payloadStartChar = buffer[payloadStart];
  return payloadStartChar === "{" || payloadStartChar === "[" ? start : null;
}

function findForeignPartialToolCallSuffixStart(lower: string): number | null {
  const maxLen = Math.min(
    FOREIGN_TOOL_CALL_OPEN_MARKER.length - 1,
    lower.length
  );
  for (let len = maxLen; len > 0; len -= 1) {
    if (lower.endsWith(FOREIGN_TOOL_CALL_OPEN_MARKER.slice(0, len))) {
      return lower.length - len;
    }
  }
  return null;
}

export function findForeignBlockHoldStart(buffer: string): number | null {
  const lower = buffer.toLowerCase();
  let searchIndex = 0;
  while (searchIndex < lower.length) {
    const start = lower.indexOf(FOREIGN_TOOL_CALL_OPEN_MARKER, searchIndex);
    if (start === -1) {
      break;
    }
    const holdStart = getForeignToolCallOpenHoldStart(buffer, lower, start);
    if (holdStart !== null) {
      return holdStart;
    }
    searchIndex = start + FOREIGN_TOOL_CALL_OPEN_MARKER.length;
  }
  return findForeignPartialToolCallSuffixStart(lower);
}

/**
 * Runs the shared JSON recovery over a foreign block and applies the
 * strictness gate: at least one call must resolve and any leftover text must
 * be markup-only. Returns null when the block should stay plain text.
 */
export function recoverGatedForeignCalls(
  block: string,
  tools: LanguageModelV4FunctionTool[]
): ForeignToolCallPart[] | null {
  const recovered = recoverToolCallFromJsonCandidates(block, tools);
  if (!recovered) {
    return null;
  }
  const calls = recovered.filter(
    (part): part is ForeignToolCallPart => part.type === "tool-call"
  );
  const hasProse = recovered.some(
    (part) =>
      part.type === "text" && !FOREIGN_SALVAGE_MARKUP_ONLY_RE.test(part.text)
  );
  if (calls.length === 0 || hasProse) {
    return null;
  }
  return calls;
}

/**
 * Cross-format salvage: some models answer the YAML-XML prompt with
 * Hermes-style `<tool_call>` JSON payloads instead (observed live on IBM
 * Granite 4.0). Leftover text segments containing such blocks are re-scanned
 * with the shared JSON recovery before being emitted as plain text.
 */
export function addTextOrForeignToolCalls(
  segment: string,
  processedElements: LanguageModelV4Content[],
  tools: LanguageModelV4FunctionTool[]
): void {
  if (segment.length === 0) {
    return;
  }
  if (!FOREIGN_TOOL_CALL_BLOCK_RE.test(segment)) {
    addTextSegment(segment, processedElements);
    return;
  }
  const recovered = recoverToolCallFromJsonCandidates(segment, tools);
  if (!recovered?.some((part) => part.type === "tool-call")) {
    addForeignFallbackText(segment, processedElements);
    return;
  }
  for (const part of recovered) {
    if (part.type === "text") {
      addForeignFallbackText(part.text, processedElements);
    } else {
      processedElements.push(part);
    }
  }
}

export function addForeignFallbackText(
  segment: string,
  processedElements: LanguageModelV4Content[]
): void {
  const blockRegex = new RegExp(FOREIGN_TOOL_CALL_BLOCK_RE.source, "gi");
  let cursor = 0;
  for (const match of segment.matchAll(blockRegex)) {
    const block = match[0] ?? "";
    const start = match.index ?? 0;
    if (start > cursor) {
      addTextSegment(segment.slice(cursor, start), processedElements);
    }
    if (!toolCallTextHasPrototypeSensitiveKey(block)) {
      addTextSegment(block, processedElements);
    }
    cursor = start + block.length;
  }
  if (cursor < segment.length) {
    addTextSegment(segment.slice(cursor), processedElements);
  }
}
