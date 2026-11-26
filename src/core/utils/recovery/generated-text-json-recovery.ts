import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { escapeRegExp } from "../../../shared/regex";
import type { ProtocolToolCallResolver } from "../../../shared/tool-call-resolver";
import { generateToolCallId } from "../id";
import {
  hasPrototypeSensitiveStructuralKey,
  toolCallInputHasPrototypeSensitiveKey,
  toolCallTextHasPrototypeSensitiveKey,
} from "../security/prototype-sensitive-keys";
import {
  containsPrototypeSensitiveKey,
  extractJsonLikeCandidates,
  isRecord,
  type JsonCandidate,
  parseJsonCandidate,
} from "./generated-text-json-candidates";
import {
  extractFunctionBlockCallSpans,
  extractSensitiveFunctionBlockDropSpans,
  RECOVERABLE_QWEN_CALL_TAGS,
} from "./generated-text-qwen-markup";
import { extractSensitiveIncompleteToolCallDropSpans } from "./generated-text-sensitive-candidates";
import {
  extractSensitiveYamlToolCallBlockDropSpans,
  extractYamlToolCallBlockSpans,
} from "./generated-text-yaml-markup";
import {
  hasArgumentsEnvelope,
  hasNameEnvelope,
  isLikelyArgumentsShapeForTool,
  type RecoveredCallSpan,
  type RecoverySpan,
  readToolArgsField,
  readToolNameField,
  TOOL_NAME_KEYS,
  type ToolCallCandidate,
  toToolCallCandidate,
} from "./recovery-types";

export type ToolCallJsonRecoveryResult =
  | { content: LanguageModelV4Content[]; kind: "recovered" }
  | { content: LanguageModelV4Content[]; kind: "dropped-sensitive-candidate" }
  | { kind: "none" };

function toToolCallPart(candidate: ToolCallCandidate): LanguageModelV4Content {
  return {
    type: "tool-call",
    toolCallId: generateToolCallId(),
    toolName: candidate.toolName,
    input: candidate.input,
  };
}

const ORPHAN_TAG_BEFORE_CALL_REGEX = /(?:<\/?tool_call>\s*)+$/;
const ORPHAN_TAG_AFTER_CALL_REGEX = /^(?:\s*<\/?tool_call>)+/;
/**
 * JSON array plumbing left over when calls arrive wrapped in a top-level
 * array (e.g. `[{...}, {...}]`, observed live on Seed 2.0): brackets and
 * commas between the recovered objects carry no content.
 */
const ARRAY_PUNCTUATION_ONLY_REGEX = /^[\s,[\]]*$/;

/**
 * Append a text segment between recovered calls, trimming orphan tool-call
 * wrappers on both ends. Models that half-follow a tag protocol leave
 * dangling `<tool_call>` markup around the recovered JSON (e.g.
 * `<tool_call>{...}</think>` or `<tool_call>` used as a separator between
 * consecutive payloads); stripping it keeps protocol markup out of visible
 * text.
 */
function pushRecoveredTextSegment(
  out: LanguageModelV4Content[],
  segment: string
): void {
  const trimmed = segment
    .replace(ORPHAN_TAG_AFTER_CALL_REGEX, "")
    .replace(ORPHAN_TAG_BEFORE_CALL_REGEX, "");
  if (ARRAY_PUNCTUATION_ONLY_REGEX.test(trimmed)) {
    return;
  }
  if (trimmed.trim().length > 0) {
    out.push({ type: "text", text: trimmed });
  }
}

function textHasKnownToolReference(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): boolean {
  const qwenTags = RECOVERABLE_QWEN_CALL_TAGS.join("|");
  return tools.some((tool) => {
    const name = escapeRegExp(tool.name);
    const quotedNameEnvelope = new RegExp(
      `["'](?:${TOOL_NAME_KEYS.join("|")})["']\\s*:\\s*["']${name}["']`,
      "i"
    );
    const relaxedNameEnvelope = new RegExp(
      `(?:^|[{,]\\s*)(?:${TOOL_NAME_KEYS.join("|")})\\s*:\\s*["']${name}["']`,
      "i"
    );
    const qwenNameEnvelope = new RegExp(
      `<\\s*(?:${qwenTags})\\b[^>]*(?:=\\s*["']?${name}["']?|\\bname\\s*=\\s*["']${name}["'])`,
      "i"
    );
    return (
      quotedNameEnvelope.test(text) ||
      relaxedNameEnvelope.test(text) ||
      qwenNameEnvelope.test(text)
    );
  });
}

function parseAsToolPayload(
  payload: unknown,
  tools: LanguageModelV4FunctionTool[]
): ToolCallCandidate | null {
  if (!isRecord(payload)) {
    return null;
  }

  const toolName = readToolNameField(payload);
  if (!toolName) {
    return null;
  }

  if (!tools.some((tool) => tool.name === toolName)) {
    return null;
  }

  let rawArgs = readToolArgsField(payload);
  // Double-encoded arguments (OpenAI native wire habit): a string value that
  // itself parses to a JSON object.
  if (
    typeof rawArgs === "string" &&
    rawArgs.trimStart().startsWith("{") &&
    !toolCallTextHasPrototypeSensitiveKey(rawArgs)
  ) {
    const unwrapped = parseJsonCandidate(rawArgs);
    if (isRecord(unwrapped)) {
      rawArgs = unwrapped;
    }
  }
  if (!isRecord(rawArgs) || containsPrototypeSensitiveKey(rawArgs)) {
    return null;
  }

  return toToolCallCandidate(toolName, rawArgs, tools);
}

function parseAsArgumentsOnly(
  payload: unknown,
  tools: LanguageModelV4FunctionTool[]
): ToolCallCandidate | null {
  if (tools.length !== 1) {
    return null;
  }
  if (!isRecord(payload)) {
    return null;
  }
  if (hasNameEnvelope(payload) || hasArgumentsEnvelope(payload)) {
    return null;
  }

  const [tool] = tools;
  if (
    !isLikelyArgumentsShapeForTool(payload, tool) ||
    containsPrototypeSensitiveKey(payload)
  ) {
    return null;
  }

  return toToolCallCandidate(tool.name, payload, tools);
}

function looksLikeKnownToolCandidate(
  payload: unknown,
  tools: LanguageModelV4FunctionTool[]
): boolean {
  if (!isRecord(payload)) {
    return false;
  }

  const toolName = readToolNameField(payload);
  if (toolName && tools.some((tool) => tool.name === toolName)) {
    return true;
  }

  if (
    tools.length === 1 &&
    !hasNameEnvelope(payload) &&
    !hasArgumentsEnvelope(payload) &&
    isLikelyArgumentsShapeForTool(payload, tools[0])
  ) {
    return true;
  }

  return false;
}

function isSensitiveRejectedJsonCandidate(
  candidate: JsonCandidate,
  tools: LanguageModelV4FunctionTool[]
): boolean {
  const rawSensitive = toolCallTextHasPrototypeSensitiveKey(candidate.text);
  const parsed = parseJsonCandidate(candidate.text);
  const knownToolCandidate = looksLikeKnownToolCandidate(parsed, tools);
  const structuralSensitive =
    parsed !== undefined && hasPrototypeSensitiveStructuralKey(parsed);
  const stringArgumentsSensitive =
    isRecord(parsed) &&
    typeof readToolArgsField(parsed) === "string" &&
    toolCallTextHasPrototypeSensitiveKey(readToolArgsField(parsed) as string);
  const inputSensitive =
    knownToolCandidate &&
    parsed !== undefined &&
    toolCallInputHasPrototypeSensitiveKey(parsed);

  if (
    !(
      rawSensitive ||
      structuralSensitive ||
      stringArgumentsSensitive ||
      inputSensitive
    )
  ) {
    return false;
  }

  if (knownToolCandidate) {
    return true;
  }

  return textHasKnownToolReference(candidate.text, tools);
}

function resolveCandidatePayload(
  candidate: JsonCandidate,
  tools: LanguageModelV4FunctionTool[],
  resolver?: ProtocolToolCallResolver
): ToolCallCandidate | null {
  if (toolCallTextHasPrototypeSensitiveKey(candidate.text)) {
    return null;
  }
  const parsed = parseJsonCandidate(candidate.text);
  if (parsed === undefined) {
    return null;
  }
  if (hasPrototypeSensitiveStructuralKey(parsed)) {
    return null;
  }
  if (
    resolver &&
    looksLikeKnownToolCandidate(parsed, tools) &&
    isRecord(parsed) &&
    Object.hasOwn(parsed, "arguments")
  ) {
    const resolved = resolver(candidate.text, tools);
    if (resolved.ok) {
      return { toolName: resolved.toolName, input: resolved.input };
    }
  }
  return (
    parseAsToolPayload(parsed, tools) ?? parseAsArgumentsOnly(parsed, tools)
  );
}

function isRecoveredSpan(span: RecoverySpan): span is RecoveredCallSpan {
  return "payload" in span;
}

/**
 * Recover tool calls embedded in plain text. Candidates come from three
 * scanners, each validated against the known tools:
 *
 *   1. JSON-like candidates (bare objects, fenced blocks, tagged bodies)
 *   2. Qwen3-Coder-style `<function=name><parameter=key>value` blocks
 *   3. `<tool_call>` blocks with YAML mapping bodies
 *
 * Every non-overlapping candidate that resolves becomes a tool-call part, so
 * multi-call payloads (consecutive bare JSON objects, orphan `<tool_call>`
 * separators, array-wrapped lists) are all recovered. Prototype-sensitive
 * known-tool candidates are consumed instead of falling back to visible text.
 */
export function recoverToolCallFromJsonCandidatesWithStatus(
  text: string,
  tools: LanguageModelV4FunctionTool[],
  resolver?: ProtocolToolCallResolver
): ToolCallJsonRecoveryResult {
  if (tools.length === 0) {
    return { kind: "none" };
  }

  const spans: RecoverySpan[] = [];
  for (const jsonCandidate of extractJsonLikeCandidates(text)) {
    const payload = resolveCandidatePayload(jsonCandidate, tools, resolver);
    if (payload) {
      spans.push({
        startIndex: jsonCandidate.startIndex,
        endIndex: jsonCandidate.endIndex,
        payload,
      });
    } else if (isSensitiveRejectedJsonCandidate(jsonCandidate, tools)) {
      spans.push({
        startIndex: jsonCandidate.startIndex,
        endIndex: jsonCandidate.endIndex,
        dropReason: "prototype-sensitive-tool-candidate",
      });
    }
  }
  spans.push(...extractFunctionBlockCallSpans(text, tools));
  spans.push(...extractSensitiveFunctionBlockDropSpans(text, tools));
  spans.push(...extractYamlToolCallBlockSpans(text, tools));
  spans.push(...extractSensitiveYamlToolCallBlockDropSpans(text, tools));
  spans.push(...extractSensitiveIncompleteToolCallDropSpans(text, tools));
  spans.sort((a, b) =>
    a.startIndex === b.startIndex
      ? b.endIndex - a.endIndex
      : a.startIndex - b.startIndex
  );

  const out: LanguageModelV4Content[] = [];
  let cursor = 0;
  let recoveredAny = false;
  let droppedSensitiveAny = false;

  for (const span of spans) {
    if (span.startIndex < cursor) {
      // Overlaps a candidate that was already consumed (e.g. the balanced
      // object inside an already-recovered tagged/fenced candidate).
      continue;
    }
    pushRecoveredTextSegment(out, text.slice(cursor, span.startIndex));
    cursor = span.endIndex;
    if (isRecoveredSpan(span)) {
      out.push(toToolCallPart(span.payload));
      recoveredAny = true;
    } else {
      droppedSensitiveAny = true;
    }
  }

  if (recoveredAny || droppedSensitiveAny) {
    pushRecoveredTextSegment(out, text.slice(cursor));
  }

  if (!recoveredAny) {
    return droppedSensitiveAny
      ? { kind: "dropped-sensitive-candidate", content: out }
      : { kind: "none" };
  }

  return { kind: "recovered", content: out };
}

export function recoverToolCallFromJsonCandidates(
  text: string,
  tools: LanguageModelV4FunctionTool[],
  resolver?: ProtocolToolCallResolver
): LanguageModelV4Content[] | null {
  const result = recoverToolCallFromJsonCandidatesWithStatus(
    text,
    tools,
    resolver
  );
  return result.kind === "recovered" ? result.content : null;
}

/**
 * Recover foreign-format tool calls from a candidate block only when at least
 * one known call resolves and every leftover text segment consists exclusively
 * of allowed markup remnants (no non-markup prose).
 */
export function recoverMarkupOnlyForeignToolCalls(
  text: string,
  tools: LanguageModelV4FunctionTool[],
  markupOnlyRegex: RegExp
): Extract<LanguageModelV4Content, { type: "tool-call" }>[] | null {
  const recovered = recoverToolCallFromJsonCandidates(text, tools);
  if (!recovered) {
    return null;
  }
  const calls = recovered.filter(
    (part): part is Extract<LanguageModelV4Content, { type: "tool-call" }> =>
      part.type === "tool-call"
  );
  const hasProse = recovered.some(
    (part) => part.type === "text" && !markupOnlyRegex.test(part.text)
  );
  if (calls.length === 0 || hasProse) {
    return null;
  }
  return calls;
}
