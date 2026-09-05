import {
  isJSONObject,
  type JSONObject,
  type LanguageModelV4Content,
  type LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import type { ProtocolToolCallResolver } from "../protocols/protocol-interface";
import {
  extractFunctionBlockCallSpans,
  extractSensitiveFunctionBlockDropSpans,
  extractSensitiveYamlToolCallBlockDropSpans,
  extractYamlToolCallBlockSpans,
} from "./generated-text-block-recovery";
import {
  containsPrototypeSensitiveKey,
  extractJsonLikeCandidates,
  type JsonCandidate,
  parseJsonCandidate,
} from "./generated-text-json-candidates";
import { extractSensitiveIncompleteToolCallDropSpans } from "./generated-text-sensitive-candidates";
import {
  type DroppedSensitiveSpan,
  hasArgumentsEnvelope,
  hasNameEnvelope,
  isLikelyArgumentsShapeForTool,
  type RecoveredCallSpan,
  readToolArgsField,
  readToolNameField,
  TOOL_NAME_KEYS,
  type ToolCallCandidate,
  toToolCallCandidate,
} from "./generated-text-tool-candidates";
import { generateToolCallId } from "./id";
import {
  hasPrototypeSensitiveStructuralKey,
  toolCallInputHasPrototypeSensitiveKey,
  toolCallTextHasPrototypeSensitiveKey,
} from "./prototype-sensitive-keys";

type RecoverySpan = DroppedSensitiveSpan | RecoveredCallSpan;

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

/**
 * Envelope key aliases observed live (e.g. Nemotron emits tool/parameters,
 * gpt-oss emits function/parameters). Resolved names are validated against
 * the declared tools, so aliases cannot misfire on arbitrary JSON.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textHasKnownToolReference(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): boolean {
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
      `<\\s*(?:call|function|tool|invoke)\\b[^>]*(?:=\\s*["']?${name}["']?|\\bname\\s*=\\s*["']${name}["'])`,
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
  payload: JSONObject,
  tools: LanguageModelV4FunctionTool[]
): ToolCallCandidate | null {
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
    if (isJSONObject(unwrapped)) {
      rawArgs = unwrapped;
    }
  }
  if (!isJSONObject(rawArgs) || containsPrototypeSensitiveKey(rawArgs)) {
    return null;
  }

  return toToolCallCandidate(toolName, rawArgs, tools);
}

function parseAsArgumentsOnly(
  payload: JSONObject,
  tools: LanguageModelV4FunctionTool[]
): ToolCallCandidate | null {
  if (tools.length !== 1) {
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
  payload: JSONObject,
  tools: LanguageModelV4FunctionTool[]
): boolean {
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
  const parsedObject = isJSONObject(parsed) ? parsed : null;
  const knownToolCandidate =
    parsedObject !== null && looksLikeKnownToolCandidate(parsedObject, tools);
  const structuralSensitive =
    parsedObject !== null && hasPrototypeSensitiveStructuralKey(parsedObject);
  const parsedArguments =
    parsedObject === null ? undefined : readToolArgsField(parsedObject);
  const stringArgumentsSensitive =
    typeof parsedArguments === "string" &&
    toolCallTextHasPrototypeSensitiveKey(parsedArguments);
  const inputSensitive =
    knownToolCandidate && toolCallInputHasPrototypeSensitiveKey(parsedObject);

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
  if (!isJSONObject(parsed)) {
    return null;
  }
  if (hasPrototypeSensitiveStructuralKey(parsed)) {
    return null;
  }
  if (
    resolver &&
    looksLikeKnownToolCandidate(parsed, tools) &&
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
