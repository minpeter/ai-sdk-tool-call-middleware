import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import YAML from "yaml";
import { unescapeXml } from "../../rxml/utils/helpers";
import { safeToolCallMetadataText } from "../utils/protocol-utils";
import { toolCallTextHasPrototypeSensitiveKey } from "../utils/prototype-sensitive-keys";
import { NAME_CHAR_RE, WHITESPACE_REGEX } from "../utils/regex-constants";
import { findNextToolTag } from "../utils/xml-tool-tag-scanner";

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
export interface ToolCallMatch {
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

export function findToolCalls(
  text: string,
  toolNames: string[]
): ToolCallMatch[] {
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

// A YAML block scalar is not prefix-stable while it is streaming: indentation
// discovered by later lines and the final chomping decision can rewrite text
// that was already parsed. Buffer these bodies until the closing tool tag so
// emitted JSON deltas can never disagree with the final parse.
export const YAML_BLOCK_SCALAR_HEADER_RE =
  /^(?:[^\r\n]*:\s*|[ \t]*-\s*)[|>][1-9+-]{0,2}(?:[ \t]+#.*)?\r?$/m;

function yamlFailureCause(failure: YamlParseFailure): Record<string, unknown> {
  if (failure.kind === "yaml-parse-error") {
    return { kind: "yaml-parse-error", errors: failure.errors };
  }
  return { kind: "yaml-non-mapping" };
}

export function safeYamlFailureCause(
  failure: YamlParseFailure,
  rawToolCallText: string
): Record<string, unknown> {
  if (!toolCallTextHasPrototypeSensitiveKey(rawToolCallText)) {
    return yamlFailureCause(failure);
  }
  if (failure.kind === "yaml-parse-error") {
    return {
      kind: "yaml-parse-error",
      errors: [safeToolCallMetadataText(rawToolCallText)],
    };
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
export function buildSchemaPropNameSet(
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

export function parseYamlContent(
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

export function parseYamlContentForStreamProgress(
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

export function stripTrailingPartialCloseTag(
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
