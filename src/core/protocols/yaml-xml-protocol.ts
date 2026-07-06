import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolCall,
} from "@ai-sdk/provider";
import YAML from "yaml";
import { unescapeXml } from "../../rxml/utils/helpers";
import { recoverToolCallFromJsonCandidates } from "../utils/generated-text-json-recovery";
import { generateToolCallId } from "../utils/id";
import {
  addTextSegment,
  createFlushTextHandler,
  extractToolNames,
  formatToolsWithPromptTemplate,
} from "../utils/protocol-utils";
import { NAME_CHAR_RE, WHITESPACE_REGEX } from "../utils/regex-constants";
import {
  emitFailedToolInputLifecycle,
  emitFinalizedToolInputLifecycle,
  emitToolInputProgressDelta,
  enqueueToolInputEndAndCall,
  shouldEmitRawToolCallTextOnError,
  stringifyToolInputWithSchema,
} from "../utils/tool-input-streaming";
import { tryRepairXmlSelfClosingRootWithBody } from "../utils/xml-root-repair";
import {
  findEarliestToolTag,
  findNextToolTag,
  findPotentialPartialToolTagStart,
} from "../utils/xml-tool-tag-scanner";
import type { ParserOptions, TCMCoreProtocol } from "./protocol-interface";

export interface YamlXmlProtocolOptions {
  /**
   * Whether to include a system prompt example showing YAML multiline syntax.
   * @default true
   */
  includeMultilineExample?: boolean;
}

const LEADING_WHITESPACE_RE = /^(\s*)/;
const INCOMPLETE_MAPPING_TAIL_RE = /^[^:[\]{}-][^:]*:\s*$/;
const INCOMPLETE_SEQUENCE_TAIL_RE = /^-\s*$/;
const BLOCK_SCALAR_KEY_RE = /:\s*[|>][-+0-9]*\s*$/;
const PLAIN_MAPPING_VALUE_RE = /^[^:[\]{}-][^:]*:\s*(.+)$/;
const PLAIN_SEQUENCE_VALUE_RE = /^-\s+(.+)$/;

interface LastMeaningfulLineInfo {
  indent: number;
  index: number;
  raw: string;
  trimmed: string;
}

function normalizeYamlContent(yamlContent: string): {
  normalized: string;
  nonEmptyLines: string[];
} {
  let normalized = yamlContent;
  if (normalized.startsWith("\n")) {
    normalized = normalized.slice(1);
  }

  const lines = normalized.split("\n");
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  if (nonEmptyLines.length === 0) {
    return { normalized: "", nonEmptyLines };
  }

  const minIndent = Math.min(
    ...nonEmptyLines.map((line) => {
      const match = line.match(LEADING_WHITESPACE_RE);
      return match ? match[1].length : 0;
    })
  );
  if (minIndent > 0) {
    normalized = lines.map((line) => line.slice(minIndent)).join("\n");
  }

  return { normalized, nonEmptyLines };
}

function parseYamlDocumentAsMapping(normalized: string): {
  value: Record<string, unknown> | null;
  errors: string[];
} {
  try {
    const doc = YAML.parseDocument(normalized);
    const errors = doc.errors.map((e: { message: string }) => e.message);
    const result = doc.toJSON();

    if (result === null) {
      return { value: {}, errors };
    }
    if (typeof result !== "object" || Array.isArray(result)) {
      return { value: null, errors };
    }
    return { value: result as Record<string, unknown>, errors };
  } catch (error) {
    return {
      value: null,
      errors: [
        error instanceof Error ? error.message : "Unknown YAML parsing error",
      ],
    };
  }
}

function getLastMeaningfulLineInfo(
  input: string
): LastMeaningfulLineInfo | null {
  const lines = input.split("\n");
  let index = lines.length - 1;
  while (index >= 0) {
    const raw = lines[index] ?? "";
    const trimmed = raw.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("#")) {
      return {
        index,
        raw,
        trimmed,
        indent: raw.length - raw.trimStart().length,
      };
    }
    index -= 1;
  }
  return null;
}

function dropLastMeaningfulLine(input: string): string | null {
  const lineInfo = getLastMeaningfulLineInfo(input);
  if (!lineInfo) {
    return null;
  }

  return input.split("\n").slice(0, lineInfo.index).join("\n").trimEnd();
}

function hasIncompleteMappingTail(normalized: string): boolean {
  const lineInfo = getLastMeaningfulLineInfo(normalized);
  if (!lineInfo) {
    return false;
  }
  return INCOMPLETE_MAPPING_TAIL_RE.test(lineInfo.trimmed);
}

function hasIncompleteSequenceTail(normalized: string): boolean {
  const lineInfo = getLastMeaningfulLineInfo(normalized);
  if (!lineInfo) {
    return false;
  }
  return INCOMPLETE_SEQUENCE_TAIL_RE.test(lineInfo.trimmed);
}

function hasSplitNestedKeyTail(normalized: string): boolean {
  const lineInfo = getLastMeaningfulLineInfo(normalized);
  if (!lineInfo) {
    return false;
  }

  const { trimmed, indent, index } = lineInfo;
  if (indent === 0) {
    return false;
  }
  if (
    trimmed.startsWith("#") ||
    trimmed.startsWith("-") ||
    trimmed.includes(":")
  ) {
    return false;
  }

  const lines = normalized.split("\n");
  let parentIndex = index - 1;
  while (parentIndex >= 0) {
    const parentRaw = lines[parentIndex] ?? "";
    const parentTrimmed = parentRaw.trim();
    if (parentTrimmed.length === 0 || parentTrimmed.startsWith("#")) {
      parentIndex -= 1;
      continue;
    }

    const parentIndent = parentRaw.length - parentRaw.trimStart().length;
    if (parentIndent >= indent) {
      parentIndex -= 1;
      continue;
    }

    if (!parentTrimmed.endsWith(":")) {
      return false;
    }
    if (BLOCK_SCALAR_KEY_RE.test(parentTrimmed)) {
      return false;
    }
    return true;
  }

  return false;
}

function extractTrailingPlainScalarValue(line: string): string | null {
  if (BLOCK_SCALAR_KEY_RE.test(line)) {
    return null;
  }

  const mappingMatch = line.match(PLAIN_MAPPING_VALUE_RE);
  const sequenceMatch = line.match(PLAIN_SEQUENCE_VALUE_RE);
  const value = mappingMatch?.[1] ?? sequenceMatch?.[1];
  if (!value) {
    return null;
  }

  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return null;
  }
  if (trimmedValue.startsWith('"') || trimmedValue.startsWith("'")) {
    return null;
  }
  if (
    trimmedValue.startsWith("{") ||
    trimmedValue.startsWith("[") ||
    trimmedValue.startsWith("|") ||
    trimmedValue.startsWith(">")
  ) {
    return null;
  }

  return trimmedValue;
}

function hasUnterminatedPlainScalarTail(normalized: string): boolean {
  if (normalized.endsWith("\n")) {
    return false;
  }

  const lineInfo = getLastMeaningfulLineInfo(normalized);
  if (!lineInfo) {
    return false;
  }

  return extractTrailingPlainScalarValue(lineInfo.trimmed) != null;
}

function hasUnstableProgressTail(normalized: string): boolean {
  return (
    hasIncompleteMappingTail(normalized) ||
    hasIncompleteSequenceTail(normalized) ||
    hasSplitNestedKeyTail(normalized) ||
    hasUnterminatedPlainScalarTail(normalized)
  );
}

function trimTrailingNewlineInUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.endsWith("\n")) {
      return value.slice(0, -1);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => trimTrailingNewlineInUnknown(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        trimTrailingNewlineInUnknown(item),
      ])
    );
  }

  return value;
}

function stabilizeParsedValueForStreamProgress<T>(value: T, source: string): T {
  if (source.endsWith("\n")) {
    return value;
  }

  return trimTrailingNewlineInUnknown(value) as T;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: XML tag parsing with nested tag tracking inherently requires complex state management
function findClosingTagEnd(
  text: string,
  contentStart: number,
  toolName: string
): number {
  let pos = contentStart;
  let depth = 1;

  while (pos < text.length) {
    const ltIdx = text.indexOf("<", pos);
    if (ltIdx === -1) {
      break;
    }

    const next = text[ltIdx + 1];
    if (next === "/") {
      const gtIdx = text.indexOf(">", ltIdx);
      if (gtIdx === -1) {
        break;
      }

      let p = ltIdx + 2;
      while (p < gtIdx && WHITESPACE_REGEX.test(text[p])) {
        p += 1;
      }
      const nameStart = p;
      while (p < gtIdx && NAME_CHAR_RE.test(text.charAt(p))) {
        p += 1;
      }
      const name = text.slice(nameStart, p);

      if (name === toolName) {
        depth -= 1;
        if (depth === 0) {
          return gtIdx + 1;
        }
      }
      pos = gtIdx + 1;
    } else if (next === "!" || next === "?") {
      const gtIdx = text.indexOf(">", ltIdx);
      pos = gtIdx === -1 ? text.length : gtIdx + 1;
    } else {
      let p = ltIdx + 1;
      while (p < text.length && WHITESPACE_REGEX.test(text[p])) {
        p += 1;
      }
      const nameStart = p;
      while (p < text.length && NAME_CHAR_RE.test(text.charAt(p))) {
        p += 1;
      }
      const name = text.slice(nameStart, p);

      const gtIdx = text.indexOf(">", p);
      if (gtIdx === -1) {
        break;
      }

      let r = gtIdx - 1;
      while (r >= nameStart && WHITESPACE_REGEX.test(text[r])) {
        r -= 1;
      }
      const selfClosing = text[r] === "/";

      if (name === toolName && !selfClosing) {
        depth += 1;
      }
      pos = gtIdx + 1;
    }
  }

  return -1;
}

/**
 * Find all tool calls in the text for the given tool names.
 */
interface ToolCallMatch {
  content: string;
  endIndex: number;
  startIndex: number;
  toolName: string;
}

function collectToolCallsForName(
  text: string,
  toolName: string
): ToolCallMatch[] {
  const toolCalls: ToolCallMatch[] = [];
  let searchIndex = 0;
  const startTag = `<${toolName}>`;

  while (searchIndex < text.length) {
    const match = findNextToolTag(text, searchIndex, toolName);
    if (match === null) {
      break;
    }

    const { tagStart } = match;
    const { isSelfClosing } = match;

    if (isSelfClosing) {
      const endIndex = tagStart + match.tagLength;
      toolCalls.push({
        toolName,
        startIndex: tagStart,
        endIndex,
        content: "",
      });
      searchIndex = endIndex;
      continue;
    }

    const contentStart = tagStart + startTag.length;
    const fullTagEnd = findClosingTagEnd(text, contentStart, toolName);
    if (fullTagEnd !== -1 && fullTagEnd > contentStart) {
      const endTag = `</${toolName}>`;
      const endTagStart = fullTagEnd - endTag.length;
      const content = text.slice(contentStart, endTagStart);
      toolCalls.push({
        toolName,
        startIndex: tagStart,
        endIndex: fullTagEnd,
        content,
      });
      searchIndex = fullTagEnd;
    } else {
      searchIndex = contentStart;
    }
  }

  return toolCalls;
}

function findToolCalls(text: string, toolNames: string[]): ToolCallMatch[] {
  const toolCalls = toolNames.flatMap((toolName) =>
    collectToolCallsForName(text, toolName)
  );
  return toolCalls.sort((a, b) => a.startIndex - b.startIndex);
}

type YamlParseFailure =
  | { kind: "yaml-parse-error"; errors: readonly string[] }
  | { kind: "yaml-non-mapping" };

type YamlParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; failure: YamlParseFailure };

function yamlFailureCause(failure: YamlParseFailure): Record<string, unknown> {
  if (failure.kind === "yaml-parse-error") {
    return { kind: "yaml-parse-error", errors: failure.errors };
  }
  return { kind: "yaml-non-mapping" };
}

/**
 * Parse YAML content from inside an XML tag.
 * Handles common LLM output issues like inconsistent indentation.
 *
 * Returns a structured result instead of calling onError directly so the
 * caller can surface a single uniform onError metadata shape
 * (`toolCall`, `toolName`, `toolCallId`, `dropReason`) with the underlying
 * helper cause attached as context.
 */
const XML_CHILD_CLOSED_LINE_REGEX = /^<([A-Za-z_][\w.-]*)\s*>([^<]*)<\/\1\s*>$/;
// The open form requires a non-empty value so that a lone nesting tag like
// `<passenger>` never gets misread as an empty flat parameter.
const XML_CHILD_OPEN_LINE_REGEX = /^<([A-Za-z_][\w.-]*)\s*>([^<]*\S[^<]*|\S)$/;
const PROTOTYPE_SENSITIVE_PARAM_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function mergeXmlChildArg(
  args: Record<string, unknown>,
  key: string,
  value: string
): void {
  const existing = args[key];
  if (existing === undefined) {
    args[key] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    args[key] = [existing, value];
  }
}

/**
 * Fallback for models that answer the YAML-body prompt with XML child tags
 * instead (`<city>Seoul</city>`, observed live on Amazon Nova 2 Lite —
 * effectively the morph-xml body format). Parses line-oriented
 * `<key>value</key>` pairs, tolerating a missing close tag on a line
 * (`<unit>celsius`), and declines on anything else so genuine YAML failures
 * keep their normal error handling.
 */
function parseXmlChildrenAsArgs(
  content: string
): Record<string, unknown> | null {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0 || !lines[0].startsWith("<")) {
    return null;
  }

  const args: Record<string, unknown> = {};
  for (const line of lines) {
    const match =
      XML_CHILD_CLOSED_LINE_REGEX.exec(line) ??
      XML_CHILD_OPEN_LINE_REGEX.exec(line);
    if (!match) {
      return null;
    }
    const [, key] = match;
    if (PROTOTYPE_SENSITIVE_PARAM_KEYS.has(key)) {
      return null;
    }
    mergeXmlChildArg(args, key, unescapeXml((match[2] ?? "").trim()));
  }

  return args;
}

/** Canonical property names declared in a tool's input schema. */
function buildSchemaPropNameSet(
  toolName: string | null | undefined,
  tools: LanguageModelV4FunctionTool[]
): Set<string> | null {
  if (!toolName) {
    return null;
  }
  const tool = tools.find((t) => t.name === toolName);
  const properties = (
    tool?.inputSchema as
      | { properties?: Record<string, unknown> }
      | null
      | undefined
  )?.properties;
  if (!properties || typeof properties !== "object") {
    return null;
  }
  const names = Object.keys(properties).filter(
    (key) => !PROTOTYPE_SENSITIVE_PARAM_KEYS.has(key)
  );
  return names.length > 0 ? new Set(names) : null;
}

const SCHEMA_KEYED_LINE_RE = /^([A-Za-z_][\w.-]*)\s*:\s?(.*)$/;
const LINE_SPLIT_RE = /\r?\n/;

/**
 * Schema-keyed raw-string salvage for YAML bodies that fail to parse because
 * a value is an unquoted multi-line scalar (e.g. Python docstrings starting
 * with `"""` — observed live on Mistral Small). Column-0 `key:` lines whose
 * key is a schema property start a field; everything until the next such key
 * line is taken verbatim as the value. Declines when no schema key matches or
 * when meaningful content precedes the first key.
 */
function parseSchemaKeyedRawStrings(
  content: string,
  schemaPropNames: Set<string> | null
): Record<string, unknown> | null {
  if (!schemaPropNames || schemaPropNames.size === 0) {
    return null;
  }

  const lines = content.split(LINE_SPLIT_RE);
  const args: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentLines: string[] = [];
  let matchedKeys = 0;

  const flush = () => {
    if (currentKey !== null) {
      args[currentKey] = currentLines.join("\n");
    }
  };

  for (const line of lines) {
    const match = SCHEMA_KEYED_LINE_RE.exec(line);
    if (match?.[1] && schemaPropNames.has(match[1])) {
      flush();
      [, currentKey] = match;
      currentLines = match[2] ? [match[2]] : [];
      matchedKeys += 1;
    } else if (currentKey !== null) {
      currentLines.push(line);
    } else if (line.trim().length > 0) {
      return null;
    }
  }
  flush();

  return matchedKeys > 0 ? args : null;
}

function parseYamlContent(
  yamlContent: string,
  schemaPropNames?: Set<string> | null
): YamlParseResult {
  const { normalized, nonEmptyLines } = normalizeYamlContent(yamlContent);
  if (nonEmptyLines.length === 0) {
    return { ok: true, value: {} };
  }

  const parsed = parseYamlDocumentAsMapping(normalized);
  if (parsed.errors.length > 0) {
    const salvaged =
      parseXmlChildrenAsArgs(yamlContent) ??
      parseSchemaKeyedRawStrings(yamlContent, schemaPropNames ?? null);
    if (salvaged) {
      return { ok: true, value: salvaged };
    }
    return {
      ok: false,
      failure: { kind: "yaml-parse-error", errors: parsed.errors },
    };
  }

  if (parsed.value === null) {
    const salvaged =
      parseXmlChildrenAsArgs(yamlContent) ??
      parseSchemaKeyedRawStrings(yamlContent, schemaPropNames ?? null);
    if (salvaged) {
      return { ok: true, value: salvaged };
    }
    return { ok: false, failure: { kind: "yaml-non-mapping" } };
  }

  return { ok: true, value: parsed.value };
}

function parseYamlContentForStreamProgress(
  yamlContent: string
): Record<string, unknown> | null {
  const { normalized, nonEmptyLines } = normalizeYamlContent(yamlContent);
  if (nonEmptyLines.length === 0) {
    return {};
  }

  let candidate = normalized;
  while (true) {
    const parsed = parseYamlDocumentAsMapping(candidate);
    if (parsed.errors.length === 0 && !hasUnstableProgressTail(candidate)) {
      if (candidate.trim().length === 0 && normalized.trim().length > 0) {
        return null;
      }
      return stabilizeParsedValueForStreamProgress(parsed.value, candidate);
    }

    const truncated = dropLastMeaningfulLine(candidate);
    if (truncated == null) {
      return null;
    }
    if (truncated === candidate) {
      return null;
    }
    candidate = truncated;
  }
}

/** Whitespace and complete tag-like tokens only (salvage strictness gate). */
const FOREIGN_SALVAGE_MARKUP_ONLY_RE = /^\s*(?:<[^<>\n]*>\s*)*$/;

const FOREIGN_TOOL_CALL_BLOCK_RE =
  /<tool_call\b[^>]*>[\s\S]*?(?:<\/tool_call\s*>|$)/i;
const FOREIGN_TOOL_CALL_CLOSE_RE = /<\/tool_call\s*>/i;
const FOREIGN_TOOL_CALL_OPEN_MARKER = "<tool_call";

type ForeignToolCallPart = Extract<
  LanguageModelV4Content,
  { type: "tool-call" }
>;

function isForeignToolCallOpenAt(lower: string, start: number): boolean {
  const afterMarker = lower[start + FOREIGN_TOOL_CALL_OPEN_MARKER.length] ?? "";
  return !(afterMarker && NAME_CHAR_RE.test(afterMarker));
}

function findForeignToolCallOpenStart(lower: string): number {
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

function findForeignBlockHoldStart(buffer: string): number | null {
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
function recoverGatedForeignCalls(
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
function addTextOrForeignToolCalls(
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
    addTextSegment(segment, processedElements);
    return;
  }
  for (const part of recovered) {
    if (part.type === "text") {
      addTextSegment(part.text, processedElements);
    } else {
      processedElements.push(part);
    }
  }
}

function processToolCallMatch(
  text: string,
  tc: ToolCallMatch,
  currentIndex: number,
  processedElements: LanguageModelV4Content[],
  tools: LanguageModelV4FunctionTool[],
  options?: ParserOptions
): number {
  if (tc.startIndex < currentIndex) {
    return currentIndex;
  }

  addTextOrForeignToolCalls(
    text.slice(currentIndex, tc.startIndex),
    processedElements,
    tools
  );

  const result = parseYamlContent(
    tc.content,
    buildSchemaPropNameSet(tc.toolName, tools)
  );
  if (result.ok) {
    processedElements.push({
      type: "tool-call",
      toolCallId: generateToolCallId(),
      toolName: tc.toolName,
      input: JSON.stringify(result.value),
    });
  } else {
    const originalText = text.slice(tc.startIndex, tc.endIndex);
    const cause = yamlFailureCause(result.failure);
    options?.onError?.("Could not parse YAML tool call", {
      toolCall: originalText,
      toolName: tc.toolName,
      toolCallId: generateToolCallId(),
      dropReason: "malformed-tool-call-body",
      cause,
    });
    processedElements.push({ type: "text", text: originalText });
  }

  return tc.endIndex;
}

function stripTrailingPartialCloseTag(
  content: string,
  toolName: string
): string {
  const closeTag = `</${toolName}>`;
  const lastLineBreakIndex = Math.max(
    content.lastIndexOf("\n"),
    content.lastIndexOf("\r")
  );
  const lineStartIndex = lastLineBreakIndex === -1 ? 0 : lastLineBreakIndex + 1;
  const trailingLine = content.slice(lineStartIndex);
  const trimmedTrailingLine = trailingLine.trim();

  if (
    trimmedTrailingLine.length === 0 ||
    !trimmedTrailingLine.startsWith("</") ||
    trimmedTrailingLine === closeTag ||
    !closeTag.startsWith(trimmedTrailingLine)
  ) {
    return content;
  }

  const leadingWhitespaceLength =
    trailingLine.length - trailingLine.trimStart().length;
  const preservedLeadingWhitespace = trailingLine.slice(
    0,
    leadingWhitespaceLength
  );
  const contentWithoutPartial = `${content.slice(
    0,
    lineStartIndex
  )}${preservedLeadingWhitespace}`;

  return contentWithoutPartial.trimEnd();
}

export const yamlXmlProtocol = (
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- reserved for future extensibility
  _protocolOptions?: YamlXmlProtocolOptions
): TCMCoreProtocol => ({
  formatTools({ tools, toolSystemPromptTemplate }) {
    return formatToolsWithPromptTemplate({ tools, toolSystemPromptTemplate });
  },

  formatToolCall(toolCall: LanguageModelV4ToolCall): string {
    let args: Record<string, unknown> = {};
    if (toolCall.input != null) {
      try {
        args = JSON.parse(toolCall.input) as Record<string, unknown>;
      } catch {
        args = { value: toolCall.input };
      }
    }
    const yamlContent = YAML.stringify(args);
    return `<${toolCall.toolName}>\n${yamlContent}</${toolCall.toolName}>`;
  },

  parseGeneratedText({ text, tools, options }) {
    const toolNames = extractToolNames(tools);
    if (toolNames.length === 0) {
      return [{ type: "text", text }];
    }

    const processedElements: LanguageModelV4Content[] = [];
    let currentIndex = 0;
    let parseText = text;

    let toolCalls = findToolCalls(parseText, toolNames);
    if (toolCalls.length === 0) {
      const repaired = tryRepairXmlSelfClosingRootWithBody(
        parseText,
        toolNames
      );
      if (repaired) {
        const repairedCalls = findToolCalls(repaired, toolNames);
        if (repairedCalls.length > 0) {
          parseText = repaired;
          toolCalls = repairedCalls;
        }
      }
    }

    for (const tc of toolCalls) {
      currentIndex = processToolCallMatch(
        parseText,
        tc,
        currentIndex,
        processedElements,
        tools,
        options
      );
    }

    if (currentIndex < parseText.length) {
      addTextOrForeignToolCalls(
        parseText.slice(currentIndex),
        processedElements,
        tools
      );
    }

    return processedElements;
  },

  createStreamParser({ tools, options }) {
    const toolNames = extractToolNames(tools);

    let buffer = "";
    let currentToolCall: {
      name: string;
      toolCallId: string;
      emittedInput: string;
    } | null = null;
    let currentTextId: string | null = null;
    let hasEmittedTextStart = false;

    const flushText = createFlushTextHandler(
      () => currentTextId,
      (newId: string | null) => {
        currentTextId = newId;
      },
      () => hasEmittedTextStart,
      (value: boolean) => {
        hasEmittedTextStart = value;
      }
    );

    const emitToolInputProgress = (
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
      toolContent: string
    ) => {
      if (!currentToolCall) {
        return;
      }
      const parsedArgs = parseYamlContentForStreamProgress(toolContent);
      if (parsedArgs === null) {
        return;
      }
      const fullInput = stringifyToolInputWithSchema({
        toolName: currentToolCall.name,
        args: parsedArgs,
        tools,
      });
      if (fullInput === "{}" && toolContent.trim().length === 0) {
        return;
      }
      emitToolInputProgressDelta({
        controller,
        id: currentToolCall.toolCallId,
        state: currentToolCall,
        fullInput,
      });
    };

    const processToolCallEnd = (
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
      toolContent: string,
      toolName: string,
      toolCallId: string
    ) => {
      const result = parseYamlContent(
        toolContent,
        buildSchemaPropNameSet(toolName, tools)
      );
      flushText(controller);
      if (result.ok) {
        const finalInput = stringifyToolInputWithSchema({
          toolName,
          args: result.value,
          tools,
        });
        if (currentToolCall && currentToolCall.toolCallId === toolCallId) {
          emitFinalizedToolInputLifecycle({
            controller,
            id: toolCallId,
            state: currentToolCall,
            toolName,
            finalInput,
            onMismatch: options?.onError,
          });
        } else {
          enqueueToolInputEndAndCall({
            controller,
            id: toolCallId,
            toolName,
            input: finalInput,
          });
        }
      } else {
        const original = `<${toolName}>${toolContent}</${toolName}>`;
        const emitRawFallback = shouldEmitRawToolCallTextOnError(options);
        emitFailedToolInputLifecycle({
          controller,
          id: toolCallId,
          emitRawToolCallTextOnError: emitRawFallback,
          rawToolCallText: original,
          emitRawText: (rawText) => {
            flushText(controller, rawText);
          },
        });
        options?.onError?.("Could not parse streaming YAML tool call", {
          toolCall: original,
          toolName,
          toolCallId,
          dropReason: "malformed-tool-call-body",
          cause: yamlFailureCause(result.failure),
        });
      }
    };

    const finalizeUnclosedToolCall = (
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
    ) => {
      if (!currentToolCall) {
        return;
      }

      emitToolInputProgress(controller, buffer);
      const { name: toolName, toolCallId } = currentToolCall;
      const reconciledBuffer = stripTrailingPartialCloseTag(buffer, toolName);
      const result = parseYamlContent(
        reconciledBuffer,
        buildSchemaPropNameSet(toolName, tools)
      );
      flushText(controller);
      if (result.ok) {
        const finalInput = stringifyToolInputWithSchema({
          toolName,
          args: result.value,
          tools,
        });
        emitFinalizedToolInputLifecycle({
          controller,
          id: toolCallId,
          state: currentToolCall,
          toolName,
          finalInput,
          onMismatch: options?.onError,
        });
      } else {
        const unfinishedContent = `<${toolName}>${buffer}`;
        const emitRawFallback = shouldEmitRawToolCallTextOnError(options);
        emitFailedToolInputLifecycle({
          controller,
          id: toolCallId,
          emitRawToolCallTextOnError: emitRawFallback,
          rawToolCallText: unfinishedContent,
          emitRawText: (rawText) => {
            flushText(controller, rawText);
          },
        });
        options?.onError?.(
          "Could not complete streaming YAML tool call at finish.",
          {
            toolCall: unfinishedContent,
            toolCallId,
            toolName,
            dropReason: "unfinished-tool-call",
            cause: yamlFailureCause(result.failure),
          }
        );
      }

      buffer = "";
      currentToolCall = null;
    };

    const handlePendingToolCall = (
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
      endTag: string,
      toolName: string
    ): boolean => {
      const endIdx = buffer.indexOf(endTag);
      if (endIdx === -1) {
        emitToolInputProgress(controller, buffer);
        return false;
      }

      const content = buffer.slice(0, endIdx);
      emitToolInputProgress(controller, content);
      buffer = buffer.slice(endIdx + endTag.length);
      processToolCallEnd(
        controller,
        content,
        toolName,
        currentToolCall?.toolCallId ?? generateToolCallId()
      );
      currentToolCall = null;
      return true;
    };

    const flushSafeText = (
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
    ): void => {
      if (buffer.length === 0) {
        return;
      }
      // Hold back only a genuine partial tool-tag suffix or a pending foreign
      // <tool_call block; everything else is provably plain text and streams
      // out immediately.
      const holds = [
        findPotentialPartialToolTagStart(buffer, toolNames),
        findForeignBlockHoldStart(buffer),
      ].filter((value): value is number => value != null);
      const holdFrom = holds.length > 0 ? Math.min(...holds) : null;
      if (holdFrom == null) {
        flushText(controller, buffer);
        buffer = "";
        return;
      }
      if (holdFrom > 0) {
        flushText(controller, buffer.slice(0, holdFrom));
        buffer = buffer.slice(holdFrom);
      }
    };

    const emitSalvagedForeignCalls = (
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
      calls: ForeignToolCallPart[]
    ): void => {
      flushText(controller);
      for (const call of calls) {
        controller.enqueue({
          type: "tool-input-start",
          id: call.toolCallId,
          toolName: call.toolName,
        });
        if (call.input.length > 0) {
          controller.enqueue({
            type: "tool-input-delta",
            id: call.toolCallId,
            delta: call.input,
          });
        }
        enqueueToolInputEndAndCall({
          controller,
          id: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
        });
      }
    };

    /**
     * Consumes a complete foreign `<tool_call>…</tool_call>` block from the
     * buffer, emitting salvaged calls (or flushing the block as text when the
     * shared JSON recovery declines). Returns false when the buffer holds no
     * complete foreign block to consume.
     */
    const tryConsumeForeignToolCallBlock = (
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
    ): boolean => {
      const lower = buffer.toLowerCase();
      const start = findForeignToolCallOpenStart(lower);
      if (start === -1) {
        return false;
      }
      const { index: realTagIndex } = findEarliestToolTag(buffer, toolNames);
      if (realTagIndex !== -1 && realTagIndex < start) {
        return false;
      }
      const closeMatch = FOREIGN_TOOL_CALL_CLOSE_RE.exec(lower.slice(start));
      if (!closeMatch) {
        return false;
      }
      const end = start + closeMatch.index + closeMatch[0].length;
      const block = buffer.slice(start, end);
      const calls = recoverGatedForeignCalls(block, tools);
      if (calls) {
        if (start > 0) {
          flushText(controller, buffer.slice(0, start));
        }
        emitSalvagedForeignCalls(controller, calls);
        buffer = buffer.slice(end);
        return true;
      }
      // A real tool tag inside the wrapper means the block is YAML-XML with a
      // stray wrapper; leave it to the normal tag path.
      if (findEarliestToolTag(block.slice(1), toolNames).index !== -1) {
        return false;
      }
      flushText(controller, buffer.slice(0, end));
      buffer = buffer.slice(end);
      return true;
    };

    /**
     * Finish-time variant: the stream ended with an unclosed foreign block
     * still buffered. Salvage it or flush it as text.
     */
    const salvageForeignBlockAtFinish = (
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
    ): void => {
      if (!buffer) {
        return;
      }
      const lower = buffer.toLowerCase();
      const start = findForeignToolCallOpenStart(lower);
      if (start === -1) {
        flushText(controller, buffer);
        buffer = "";
        return;
      }
      const block = buffer.slice(start);
      const calls = recoverGatedForeignCalls(block, tools);
      if (!calls) {
        flushText(controller, buffer);
        buffer = "";
        return;
      }
      if (start > 0) {
        flushText(controller, buffer.slice(0, start));
      }
      emitSalvagedForeignCalls(controller, calls);
      buffer = "";
    };

    const handleNewToolTag = (
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
      tagIndex: number,
      tagName: string,
      selfClosing: boolean,
      tagLength: number
    ): void => {
      if (tagIndex > 0) {
        flushText(controller, buffer.slice(0, tagIndex));
      }

      flushText(controller);

      if (selfClosing) {
        buffer = buffer.slice(tagIndex + tagLength);
        const toolCallId = generateToolCallId();
        currentToolCall = {
          name: tagName,
          toolCallId,
          emittedInput: "",
        };
        controller.enqueue({
          type: "tool-input-start",
          id: toolCallId,
          toolName: tagName,
        });
        processToolCallEnd(controller, "", tagName, toolCallId);
        currentToolCall = null;
      } else {
        const startTag = `<${tagName}>`;
        buffer = buffer.slice(tagIndex + startTag.length);
        currentToolCall = {
          name: tagName,
          toolCallId: generateToolCallId(),
          emittedInput: "",
        };
        controller.enqueue({
          type: "tool-input-start",
          id: currentToolCall.toolCallId,
          toolName: tagName,
        });
      }
    };

    /** Returns false when the buffer is exhausted and scanning should stop. */
    const processIdleBuffer = (
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
    ): boolean => {
      if (tryConsumeForeignToolCallBlock(controller)) {
        return true;
      }

      const { index, name, selfClosing, tagLength } = findEarliestToolTag(
        buffer,
        toolNames
      );

      if (index === -1) {
        flushSafeText(controller);
        return false;
      }

      handleNewToolTag(controller, index, name, selfClosing, tagLength);
      return true;
    };

    const processBuffer = (
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
    ) => {
      while (true) {
        if (currentToolCall) {
          const toolName = currentToolCall.name;
          const endTag = `</${toolName}>`;
          if (!handlePendingToolCall(controller, endTag, toolName)) {
            break;
          }
        } else if (!processIdleBuffer(controller)) {
          break;
        }
      }
    };

    const handleFinishChunk = (
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
    ) => {
      if (currentToolCall) {
        finalizeUnclosedToolCall(controller);
      } else if (buffer) {
        salvageForeignBlockAtFinish(controller);
      }
      flushText(controller);
    };

    return new TransformStream({
      transform(chunk, controller) {
        if (chunk.type === "finish") {
          handleFinishChunk(controller);
          controller.enqueue(chunk);
          return;
        }

        // The parser re-segments text under its own synthetic ids (tool-call
        // markup is excised), so the provider's original text-start/text-end
        // envelopes are dropped instead of producing empty duplicate blocks.
        if (chunk.type === "text-start" || chunk.type === "text-end") {
          return;
        }

        if (chunk.type !== "text-delta") {
          if (!currentToolCall && buffer) {
            flushText(controller, buffer);
            buffer = "";
          }
          controller.enqueue(chunk);
          return;
        }

        const textContent =
          (chunk as unknown as { delta?: string }).delta ?? "";
        buffer += textContent;
        processBuffer(controller);
      },
      flush(controller) {
        if (currentToolCall) {
          finalizeUnclosedToolCall(controller);
        } else if (buffer) {
          salvageForeignBlockAtFinish(controller);
        }
        if (currentTextId && hasEmittedTextStart) {
          controller.enqueue({
            type: "text-end",
            id: currentTextId,
          });
          hasEmittedTextStart = false;
          currentTextId = null;
        }
      },
    });
  },

  extractToolCallSegments({ text, tools }) {
    const toolNames = tools.map((t) => t.name).filter(Boolean) as string[];
    if (toolNames.length === 0) {
      return [];
    }

    return findToolCalls(text, toolNames).map(
      (tc) => `<${tc.toolName}>${tc.content}</${tc.toolName}>`
    );
  },
});
