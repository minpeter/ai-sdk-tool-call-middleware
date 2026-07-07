import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import YAML from "yaml";
import { parse as parseRJSON } from "../../rjson";
import { unescapeXml } from "../../rxml/utils/helpers";
import { getSchemaType, unwrapJsonSchema } from "../../schema-coerce";
import { generateToolCallId } from "./id";
import {
  hasPrototypeSensitiveStructuralKey,
  isPrototypeSensitiveArgumentKey,
  toolCallInputHasPrototypeSensitiveKey,
  toolCallTextHasPrototypeSensitiveKey,
} from "./prototype-sensitive-keys";
import { coerceToolCallInput } from "./tool-call-coercion";

interface ToolCallCandidate {
  input: string;
  toolName: string;
}

/** A recovered call with the span of source text it consumes. */
interface RecoveredCallSpan {
  endIndex: number;
  payload: ToolCallCandidate;
  startIndex: number;
}

interface DroppedSensitiveSpan {
  dropReason: "prototype-sensitive-tool-candidate";
  endIndex: number;
  startIndex: number;
}

type RecoverySpan = DroppedSensitiveSpan | RecoveredCallSpan;

export type ToolCallJsonRecoveryResult =
  | { content: LanguageModelV4Content[]; kind: "recovered" }
  | { content: LanguageModelV4Content[]; kind: "dropped-sensitive-candidate" }
  | { kind: "none" };

interface JsonCandidate {
  endIndex: number;
  startIndex: number;
  text: string;
}

interface JsonScanState {
  depth: number;
  escaping: boolean;
  inString: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsPrototypeSensitiveKey(value: unknown): boolean {
  return toolCallInputHasPrototypeSensitiveKey(value);
}

function parseJsonCandidate(candidateText: string): unknown {
  try {
    return parseRJSON(candidateText);
  } catch {
    // swallow parse failures and return undefined
  }
}

function extractCodeBlockCandidates(text: string): JsonCandidate[] {
  const codeBlockRegex = /```(?:json|yaml|xml)?\s*([\s\S]*?)```/gi;
  const candidates: JsonCandidate[] = [];
  let match: RegExpExecArray | null;
  while (true) {
    match = codeBlockRegex.exec(text);
    if (!match) {
      break;
    }
    const body = match[1]?.trim();
    if (body) {
      const startIndex = match.index ?? 0;
      const endIndex = startIndex + match[0].length;
      candidates.push({
        text: body,
        startIndex,
        endIndex,
      });
    }
  }
  return candidates;
}

function scanJsonChar(state: JsonScanState, char: string): JsonScanState {
  if (state.inString) {
    if (state.escaping) {
      return { ...state, escaping: false };
    }
    if (char === "\\") {
      return { ...state, escaping: true };
    }
    if (char === '"') {
      return { ...state, inString: false };
    }
    return state;
  }

  if (char === '"') {
    return { ...state, inString: true };
  }
  if (char === "{") {
    return { ...state, depth: state.depth + 1 };
  }
  if (char === "}") {
    return { ...state, depth: Math.max(0, state.depth - 1) };
  }
  return state;
}

function extractBalancedJsonObjects(text: string): JsonCandidate[] {
  const maxCandidateLength = 10_000;
  const candidates: JsonCandidate[] = [];
  let state: JsonScanState = { depth: 0, inString: false, escaping: false };
  let currentStart: number | null = null;
  let ignoreCurrent = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (!state.inString && char === "{" && state.depth === 0) {
      currentStart = index;
      ignoreCurrent = false;
    }

    state = scanJsonChar(state, char);

    if (
      currentStart !== null &&
      !ignoreCurrent &&
      index - currentStart + 1 > maxCandidateLength
    ) {
      ignoreCurrent = true;
    }

    if (!state.inString && char === "}" && state.depth === 0) {
      if (currentStart !== null && !ignoreCurrent) {
        const endIndex = index + 1;
        const candidate = text.slice(currentStart, endIndex);
        if (candidate.length > 1) {
          candidates.push({
            text: candidate,
            startIndex: currentStart,
            endIndex,
          });
        }
      }
      currentStart = null;
      ignoreCurrent = false;
    }
  }

  return candidates;
}

function extractTaggedToolCallCandidates(rawText: string): JsonCandidate[] {
  const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  const candidates: JsonCandidate[] = [];
  let match: RegExpExecArray | null;
  while (true) {
    match = toolCallRegex.exec(rawText);
    if (!match) {
      break;
    }
    const body = match[1]?.trim();
    if (!body) {
      continue;
    }
    const startIndex = match.index ?? 0;
    const endIndex = startIndex + match[0].length;
    candidates.push({
      text: body,
      startIndex,
      endIndex,
    });
  }
  return candidates;
}

function extractJsonLikeCandidates(rawText: string): JsonCandidate[] {
  return mergeJsonCandidatesByStart(
    extractTaggedToolCallCandidates(rawText),
    extractCodeBlockCandidates(rawText),
    extractBalancedJsonObjects(rawText)
  );
}

function mergeJsonCandidatesByStart(
  tagged: JsonCandidate[],
  codeBlocks: JsonCandidate[],
  balanced: JsonCandidate[]
): JsonCandidate[] {
  return [...tagged, ...codeBlocks, ...balanced].sort((a, b) =>
    a.startIndex === b.startIndex
      ? b.endIndex - a.endIndex
      : a.startIndex - b.startIndex
  );
}

function toToolCallPart(candidate: ToolCallCandidate): LanguageModelV4Content {
  return {
    type: "tool-call",
    toolCallId: generateToolCallId(),
    toolName: candidate.toolName,
    input: candidate.input,
  };
}

function toToolCallCandidate(
  toolName: string,
  args: unknown,
  tools: LanguageModelV4FunctionTool[]
): ToolCallCandidate | null {
  const input = coerceToolCallInput(toolName, args, tools);
  return input === undefined ? null : { toolName, input };
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
const TOOL_NAME_KEYS = ["name", "tool", "function"] as const;
const TOOL_ARGS_KEYS = ["arguments", "parameters"] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readToolNameField(payload: Record<string, unknown>): string | null {
  for (const key of TOOL_NAME_KEYS) {
    if (!Object.hasOwn(payload, key)) {
      continue;
    }
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function readToolArgsField(payload: Record<string, unknown>): unknown {
  for (const key of TOOL_ARGS_KEYS) {
    if (Object.hasOwn(payload, key)) {
      return payload[key];
    }
  }
  return {};
}

function hasNameEnvelope(payload: Record<string, unknown>): boolean {
  return TOOL_NAME_KEYS.some(
    (key) =>
      Object.hasOwn(payload, key) &&
      typeof payload[key] === "string" &&
      (payload[key] as string).length > 0
  );
}

function hasArgumentsEnvelope(payload: Record<string, unknown>): boolean {
  return TOOL_ARGS_KEYS.some(
    (key) =>
      Object.hasOwn(payload, key) &&
      (typeof payload[key] === "string" || isRecord(payload[key]))
  );
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

function isLikelyArgumentsShapeForTool(
  args: Record<string, unknown>,
  tool: LanguageModelV4FunctionTool
): boolean {
  const unwrapped = unwrapJsonSchema(tool.inputSchema);
  if (!isRecord(unwrapped)) {
    return false;
  }
  if (getSchemaType(unwrapped) !== "object") {
    return false;
  }

  const { properties } = unwrapped;
  if (!isRecord(properties)) {
    return false;
  }

  const keys = Object.keys(args);
  if (keys.length === 0) {
    return false;
  }

  const knownKeys = keys.filter((key) => Object.hasOwn(properties, key));
  if (knownKeys.length === 0) {
    return false;
  }

  return true;
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
  const structuralSensitive =
    parsed !== undefined && hasPrototypeSensitiveStructuralKey(parsed);
  const stringArgumentsSensitive =
    isRecord(parsed) &&
    typeof readToolArgsField(parsed) === "string" &&
    toolCallTextHasPrototypeSensitiveKey(readToolArgsField(parsed) as string);

  if (!(rawSensitive || structuralSensitive || stringArgumentsSensitive)) {
    return false;
  }

  if (looksLikeKnownToolCandidate(parsed, tools)) {
    return true;
  }

  return textHasKnownToolReference(candidate.text, tools);
}

function resolveCandidatePayload(
  candidate: JsonCandidate,
  tools: LanguageModelV4FunctionTool[]
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
  return (
    parseAsToolPayload(parsed, tools) ?? parseAsArgumentsOnly(parsed, tools)
  );
}

function isRecoveredSpan(span: RecoverySpan): span is RecoveredCallSpan {
  return "payload" in span;
}

const QWEN_CALL_BLOCK_OPEN_REGEX = /<\s*(call|function|tool|invoke)\b[^>]*>/gi;
const QWEN_PARAM_OPEN_REGEX = /<\s*(?:parameter|param|argument|arg)\b[^>]*>/gi;
const QWEN_PARAM_BOUNDARY_REGEX =
  /<\s*(?:parameter|param|argument|arg)\b|<\s*\/\s*(?:parameter|param|argument|arg|call|function|tool|invoke)\s*>/i;
const QWEN_NAME_CHILD_REGEX =
  /<\s*(?:name|tool_name)\b[^>]*>([\s\S]*?)<\s*\/\s*(?:name|tool_name)\s*>/i;
const SELF_CLOSING_TAG_REGEX = /\/\s*>$/;
const QWEN_TAG_SHORTHAND_VALUE_REGEX =
  /^<\s*[A-Za-z_][\w.-]*\b\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>/<]+))/i;
const QWEN_NAME_ATTR_REGEX = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

function isSelfClosingTag(openTag: string): boolean {
  return SELF_CLOSING_TAG_REGEX.test(openTag);
}

function readQwenTagValue(openTag: string): string | null {
  const shorthand = QWEN_TAG_SHORTHAND_VALUE_REGEX.exec(openTag);
  const value = shorthand?.[1] ?? shorthand?.[2] ?? shorthand?.[3];
  if (value != null) {
    return unescapeXml(value);
  }

  const nameAttr = QWEN_NAME_ATTR_REGEX.exec(openTag);
  return nameAttr ? unescapeXml(nameAttr[1] ?? nameAttr[2] ?? "") : null;
}

function readQwenCallToolName(openTag: string, body: string): string | null {
  const tagValue = readQwenTagValue(openTag);
  if (tagValue?.trim()) {
    return tagValue.trim();
  }

  const nameChild = QWEN_NAME_CHILD_REGEX.exec(body);
  const childValue = nameChild?.[1];
  return childValue?.trim() ? unescapeXml(childValue).trim() : null;
}

function readFunctionBlockParams(body: string): Record<string, unknown> | null {
  const params: Record<string, unknown> = {};
  QWEN_PARAM_OPEN_REGEX.lastIndex = 0;
  let match = QWEN_PARAM_OPEN_REGEX.exec(body);
  while (match) {
    const openTag = match[0] ?? "";
    const key = readQwenTagValue(openTag)?.trim() ?? "";
    if (key.length === 0) {
      if (isSelfClosingTag(openTag)) {
        QWEN_PARAM_OPEN_REGEX.lastIndex = match.index + openTag.length;
        match = QWEN_PARAM_OPEN_REGEX.exec(body);
        continue;
      }
      return null;
    }
    if (isPrototypeSensitiveArgumentKey(key)) {
      return null;
    }
    const valueStart = match.index + match[0].length;
    if (isSelfClosingTag(openTag)) {
      params[key] = "";
      QWEN_PARAM_OPEN_REGEX.lastIndex = valueStart;
      match = QWEN_PARAM_OPEN_REGEX.exec(body);
      continue;
    }
    const boundaryMatch = QWEN_PARAM_BOUNDARY_REGEX.exec(
      body.slice(valueStart)
    );
    const valueEnd =
      boundaryMatch == null ? body.length : valueStart + boundaryMatch.index;
    params[key] = body.slice(valueStart, valueEnd).trim();
    QWEN_PARAM_OPEN_REGEX.lastIndex = valueEnd;
    match = QWEN_PARAM_OPEN_REGEX.exec(body);
  }
  return params;
}

function findQwenCallCloseTag(
  text: string,
  startIndex: number,
  tagName: string,
  beforeIndex: number
): { start: number; end: number } | null {
  const body = text.slice(startIndex, beforeIndex);
  const tagRegex = new RegExp(
    `<\\s*(\\/?)\\s*(parameter|param|argument|arg)\\b[^>]*>|<\\s*\\/\\s*${tagName}\\b[^>]*>`,
    "gi"
  );
  let parameterDepth = 0;
  let fallbackClose: { start: number; end: number } | null = null;
  let match = tagRegex.exec(body);
  while (match) {
    const tag = match[0] ?? "";
    const [, , parameterTagName] = match;
    if (parameterTagName) {
      const isClosingTag = (match[1] ?? "").length > 0;
      if (isClosingTag) {
        parameterDepth = Math.max(0, parameterDepth - 1);
      } else if (!isSelfClosingTag(tag)) {
        parameterDepth += 1;
      }
      match = tagRegex.exec(body);
      continue;
    }

    const start = startIndex + match.index;
    const close = { start, end: start + tag.length };
    if (parameterDepth === 0) {
      return close;
    }
    fallbackClose ??= close;
    match = tagRegex.exec(body);
  }
  return fallbackClose;
}

/**
 * Recover Qwen3-Coder-style `<function=name><parameter=key>value` blocks for
 * known tools regardless of the active protocol. Some models emit this
 * format no matter what the prompt asks for (observed live on Step 3.5 Flash
 * under the Hermes prompt).
 */
function extractFunctionBlockCallSpans(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): RecoveredCallSpan[] {
  const spans: RecoveredCallSpan[] = [];
  const opens = [...text.matchAll(QWEN_CALL_BLOCK_OPEN_REGEX)];

  for (let index = 0; index < opens.length; index += 1) {
    const open = opens[index];
    const tagName = (open[1] ?? "").toLowerCase();
    const openTag = open[0] ?? "";
    const bodyStart = open.index + open[0].length;
    const nextOpenIndex = opens[index + 1]?.index ?? text.length;
    const selfClosing = isSelfClosingTag(openTag);
    const close = selfClosing
      ? null
      : findQwenCallCloseTag(text, bodyStart, tagName, nextOpenIndex);
    const bodyEnd = close?.start ?? nextOpenIndex;
    const body = selfClosing ? "" : text.slice(bodyStart, bodyEnd);
    const toolName = readQwenCallToolName(openTag, body);
    if (!(toolName && tools.some((tool) => tool.name === toolName))) {
      continue;
    }

    const params = readFunctionBlockParams(body);
    if (!params) {
      continue;
    }

    const endIndex = selfClosing
      ? open.index + openTag.length
      : (close?.end ?? nextOpenIndex);
    const payload = toToolCallCandidate(toolName, params, tools);
    if (payload) {
      spans.push({
        startIndex: open.index,
        endIndex,
        payload,
      });
    }
  }

  return spans;
}

function extractSensitiveFunctionBlockDropSpans(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): DroppedSensitiveSpan[] {
  if (!toolCallTextHasPrototypeSensitiveKey(text)) {
    return [];
  }

  const spans: DroppedSensitiveSpan[] = [];
  const opens = [...text.matchAll(QWEN_CALL_BLOCK_OPEN_REGEX)];

  for (let index = 0; index < opens.length; index += 1) {
    const open = opens[index];
    const tagName = (open[1] ?? "").toLowerCase();
    const openTag = open[0] ?? "";
    const bodyStart = open.index + open[0].length;
    const nextOpenIndex = opens[index + 1]?.index ?? text.length;
    const selfClosing = isSelfClosingTag(openTag);
    const close = selfClosing
      ? null
      : findQwenCallCloseTag(text, bodyStart, tagName, nextOpenIndex);
    const bodyEnd = close?.start ?? nextOpenIndex;
    const body = selfClosing ? "" : text.slice(bodyStart, bodyEnd);
    const toolName = readQwenCallToolName(openTag, body);
    if (!(toolName && tools.some((tool) => tool.name === toolName))) {
      continue;
    }

    const endIndex = selfClosing
      ? open.index + openTag.length
      : (close?.end ?? nextOpenIndex);
    const rawBlock = text.slice(open.index, endIndex);
    if (toolCallTextHasPrototypeSensitiveKey(rawBlock)) {
      spans.push({
        startIndex: open.index,
        endIndex,
        dropReason: "prototype-sensitive-tool-candidate",
      });
    }
  }

  return spans;
}

const TOOL_CALL_BLOCK_OPEN_REGEX = /<tool_call\s*>/gi;
// Colon included for namespaced garbage closes like `</functions:get_weather>`.
const CLOSING_TAG_REGEX = /<\/\s*([A-Za-z_][\w.:-]*)\s*>/;

function parseYamlBlockMapping(body: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = YAML.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || containsPrototypeSensitiveKey(parsed)) {
    return null;
  }
  return parsed;
}

function parseYamlBlockMappingUnsafe(
  body: string
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = YAML.parse(body);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

function resolveYamlBlockPayload(
  mapping: Record<string, unknown>,
  closeTagName: string | null,
  tools: LanguageModelV4FunctionTool[]
): ToolCallCandidate | null {
  // Envelope form: `name: get_weather\narguments:\n  city: Seoul`.
  const envelopeName = readToolNameField(mapping);
  if (envelopeName && tools.some((tool) => tool.name === envelopeName)) {
    const rawArgs = readToolArgsField(mapping);
    const args = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
    if (isRecord(args) && !containsPrototypeSensitiveKey(args)) {
      return toToolCallCandidate(envelopeName, args, tools);
    }
    return null;
  }

  // Bare-args form closed by a tag carrying the tool name:
  // `<tool_call>\ncity: Seoul\n</get_weather>` (possibly namespaced, e.g.
  // `</functions:get_weather>`).
  if (closeTagName) {
    const candidates = [closeTagName, closeTagName.split(":").at(-1) ?? ""];
    const matched = candidates.find((name) =>
      tools.some((tool) => tool.name === name)
    );
    if (matched) {
      return toToolCallCandidate(matched, mapping, tools);
    }
  }

  // Bare-args form with a single tool whose schema matches.
  if (tools.length === 1 && isLikelyArgumentsShapeForTool(mapping, tools[0])) {
    return toToolCallCandidate(tools[0].name, mapping, tools);
  }

  return null;
}

/**
 * Recover `<tool_call>` blocks whose body is a YAML mapping instead of JSON
 * (observed live on IBM Granite 4.0, which emits this shape under every
 * prompt format, closing with an arbitrary tag such as `</weather>` or the
 * tool name).
 */
function extractYamlToolCallBlockSpans(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): RecoveredCallSpan[] {
  const spans: RecoveredCallSpan[] = [];

  TOOL_CALL_BLOCK_OPEN_REGEX.lastIndex = 0;
  let match = TOOL_CALL_BLOCK_OPEN_REGEX.exec(text);
  while (match) {
    const bodyStart = match.index + match[0].length;
    TOOL_CALL_BLOCK_OPEN_REGEX.lastIndex = bodyStart;
    const nextOpen = TOOL_CALL_BLOCK_OPEN_REGEX.exec(text);
    const blockEnd = nextOpen == null ? text.length : nextOpen.index;

    let body = text.slice(bodyStart, blockEnd);
    let endIndex = blockEnd;
    let closeTagName: string | null = null;

    // The close tag is unreliable in this shape — the first closing tag in
    // the block (e.g. `</weather>`, `</tool_call>`, `</get_weather>`)
    // terminates the body and may carry the tool name.
    const closeMatch = CLOSING_TAG_REGEX.exec(body);
    if (closeMatch) {
      closeTagName = closeMatch[1] ?? null;
      endIndex = bodyStart + closeMatch.index + closeMatch[0].length;
      body = body.slice(0, closeMatch.index);
    }

    const mapping = parseYamlBlockMapping(body);
    const payload = mapping
      ? resolveYamlBlockPayload(mapping, closeTagName, tools)
      : null;
    if (payload) {
      spans.push({ startIndex: match.index, endIndex, payload });
    }

    match = nextOpen;
  }

  return spans;
}

function extractSensitiveYamlToolCallBlockDropSpans(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): DroppedSensitiveSpan[] {
  const spans: DroppedSensitiveSpan[] = [];

  TOOL_CALL_BLOCK_OPEN_REGEX.lastIndex = 0;
  let match = TOOL_CALL_BLOCK_OPEN_REGEX.exec(text);
  while (match) {
    const bodyStart = match.index + match[0].length;
    TOOL_CALL_BLOCK_OPEN_REGEX.lastIndex = bodyStart;
    const nextOpen = TOOL_CALL_BLOCK_OPEN_REGEX.exec(text);
    const blockEnd = nextOpen == null ? text.length : nextOpen.index;

    let body = text.slice(bodyStart, blockEnd);
    let endIndex = blockEnd;
    let closeTagName: string | null = null;

    const closeMatch = CLOSING_TAG_REGEX.exec(body);
    if (closeMatch) {
      closeTagName = closeMatch[1] ?? null;
      endIndex = bodyStart + closeMatch.index + closeMatch[0].length;
      body = body.slice(0, closeMatch.index);
    }

    const mapping = parseYamlBlockMappingUnsafe(body);
    if (mapping && containsPrototypeSensitiveKey(mapping)) {
      const envelopeName = readToolNameField(mapping);
      const closeName = closeTagName?.split(":").at(-1) ?? "";
      const knownEnvelope =
        envelopeName !== null &&
        tools.some((tool) => tool.name === envelopeName);
      const knownClose =
        closeName.length > 0 && tools.some((tool) => tool.name === closeName);
      const likelySingleToolArgs =
        tools.length === 1 && isLikelyArgumentsShapeForTool(mapping, tools[0]);
      if (knownEnvelope || knownClose || likelySingleToolArgs) {
        spans.push({
          startIndex: match.index,
          endIndex,
          dropReason: "prototype-sensitive-tool-candidate",
        });
      }
    }

    match = nextOpen;
  }

  return spans;
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
  tools: LanguageModelV4FunctionTool[]
): ToolCallJsonRecoveryResult {
  if (tools.length === 0) {
    return { kind: "none" };
  }

  const spans: RecoverySpan[] = [];
  for (const jsonCandidate of extractJsonLikeCandidates(text)) {
    const payload = resolveCandidatePayload(jsonCandidate, tools);
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
  tools: LanguageModelV4FunctionTool[]
): LanguageModelV4Content[] | null {
  const result = recoverToolCallFromJsonCandidatesWithStatus(text, tools);
  return result.kind === "recovered" ? result.content : null;
}
