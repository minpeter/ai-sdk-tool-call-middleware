import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import YAML from "yaml";
import { parse as parseRJSON } from "../../rjson";
import { unescapeXml } from "../../rxml/utils/helpers";
import { getSchemaType, unwrapJsonSchema } from "../../schema-coerce";
import { generateToolCallId } from "./id";

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

const PROTOTYPE_SENSITIVE_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * Textual guard for prototype-sensitive keys in a JSON-like candidate.
 * Relaxed-JSON parsers may absorb a literal `__proto__` key into the object
 * prototype instead of surfacing it as an own property, so a post-parse
 * check alone cannot see it. Declining recovery on a textual match is safe:
 * the candidate simply stays plain text.
 */
const PROTOTYPE_SENSITIVE_KEY_TEXT_REGEX =
  /["'](?:__proto__|constructor|prototype)["']\s*:|[{,]\s*(?:__proto__|constructor|prototype)\s*:/;

function containsPrototypeSensitiveKey(value: unknown): boolean {
  const seen = new Set<object>();
  const stack: unknown[] = [value];

  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      stack.push(...current);
      continue;
    }
    if (!isRecord(current) || seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const key of Object.keys(current)) {
      if (PROTOTYPE_SENSITIVE_KEYS.has(key)) {
        return true;
      }
      stack.push(current[key]);
    }
  }

  return false;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function parseJsonCandidate(candidateText: string): unknown {
  try {
    return parseRJSON(candidateText);
  } catch {
    return;
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

/** Envelope key aliases observed live (e.g. Nemotron emits tool/parameters). */
const TOOL_NAME_KEYS = ["name", "tool"] as const;
const TOOL_ARGS_KEYS = ["arguments", "parameters"] as const;

function readToolNameField(payload: Record<string, unknown>): string | null {
  for (const key of TOOL_NAME_KEYS) {
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
    !PROTOTYPE_SENSITIVE_KEY_TEXT_REGEX.test(rawArgs)
  ) {
    const unwrapped = parseJsonCandidate(rawArgs);
    if (isRecord(unwrapped)) {
      rawArgs = unwrapped;
    }
  }
  if (!isRecord(rawArgs) || containsPrototypeSensitiveKey(rawArgs)) {
    return null;
  }

  return {
    toolName,
    input: safeStringify(rawArgs),
  };
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

  const properties = unwrapped.properties;
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

  if (
    unwrapped.additionalProperties === false &&
    knownKeys.length !== keys.length
  ) {
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
  const hasNameEnvelope = TOOL_NAME_KEYS.some(
    (key) =>
      Object.hasOwn(payload, key) &&
      typeof payload[key] === "string" &&
      (payload[key] as string).length > 0
  );
  const hasArgumentsEnvelope = TOOL_ARGS_KEYS.some(
    (key) =>
      Object.hasOwn(payload, key) &&
      (typeof payload[key] === "string" || isRecord(payload[key]))
  );
  if (hasNameEnvelope || hasArgumentsEnvelope) {
    return null;
  }

  const tool = tools[0];
  if (
    !isLikelyArgumentsShapeForTool(payload, tool) ||
    containsPrototypeSensitiveKey(payload)
  ) {
    return null;
  }

  return {
    toolName: tool.name,
    input: safeStringify(payload),
  };
}

function resolveCandidatePayload(
  candidate: JsonCandidate,
  tools: LanguageModelV4FunctionTool[]
): ToolCallCandidate | null {
  if (PROTOTYPE_SENSITIVE_KEY_TEXT_REGEX.test(candidate.text)) {
    return null;
  }
  const parsed = parseJsonCandidate(candidate.text);
  if (parsed === undefined) {
    return null;
  }
  return (
    parseAsToolPayload(parsed, tools) ?? parseAsArgumentsOnly(parsed, tools)
  );
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
    if (PROTOTYPE_SENSITIVE_KEYS.has(key)) {
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
  const closeRegex = new RegExp(`<\\s*\\/\\s*${tagName}\\s*>`, "i");
  const match = closeRegex.exec(text.slice(startIndex, beforeIndex));
  if (!match) {
    return null;
  }
  const start = startIndex + match.index;
  return { start, end: start + match[0].length };
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
    spans.push({
      startIndex: open.index,
      endIndex,
      payload: { toolName, input: safeStringify(params) },
    });
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
      return { toolName: envelopeName, input: safeStringify(args) };
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
      return { toolName: matched, input: safeStringify(mapping) };
    }
  }

  // Bare-args form with a single tool whose schema matches.
  if (tools.length === 1 && isLikelyArgumentsShapeForTool(mapping, tools[0])) {
    return { toolName: tools[0].name, input: safeStringify(mapping) };
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
 * separators, array-wrapped lists) are all recovered. Returns null when no
 * candidate resolves.
 */
export function recoverToolCallFromJsonCandidates(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): LanguageModelV4Content[] | null {
  if (tools.length === 0) {
    return null;
  }

  const spans: RecoveredCallSpan[] = [];
  for (const jsonCandidate of extractJsonLikeCandidates(text)) {
    const payload = resolveCandidatePayload(jsonCandidate, tools);
    if (payload) {
      spans.push({
        startIndex: jsonCandidate.startIndex,
        endIndex: jsonCandidate.endIndex,
        payload,
      });
    }
  }
  spans.push(...extractFunctionBlockCallSpans(text, tools));
  spans.push(...extractYamlToolCallBlockSpans(text, tools));
  spans.sort((a, b) =>
    a.startIndex === b.startIndex
      ? b.endIndex - a.endIndex
      : a.startIndex - b.startIndex
  );

  const out: LanguageModelV4Content[] = [];
  let cursor = 0;
  let recoveredAny = false;

  for (const span of spans) {
    if (span.startIndex < cursor) {
      // Overlaps a candidate that was already consumed (e.g. the balanced
      // object inside an already-recovered tagged/fenced candidate).
      continue;
    }
    pushRecoveredTextSegment(out, text.slice(cursor, span.startIndex));
    out.push(toToolCallPart(span.payload));
    cursor = span.endIndex;
    recoveredAny = true;
  }

  if (!recoveredAny) {
    return null;
  }

  pushRecoveredTextSegment(out, text.slice(cursor));
  return out;
}
