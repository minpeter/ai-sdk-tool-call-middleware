import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { unescapeXml } from "../../rxml/utils/helpers";
import { safeToolCallMetadataText } from "../utils/protocol-utils";
import { toolCallTextHasPrototypeSensitiveKey } from "../utils/prototype-sensitive-keys";
import {
  normalizeYamlContent,
  parseYamlContentForStreamProgress as parseYamlContentForStreamProgressImpl,
  parseYamlDocumentAsMapping,
} from "./yaml-xml-progress-parsing";
import {
  findToolCalls as findToolCallsImpl,
  type ToolCallMatch as ToolCallMatchImpl,
} from "./yaml-xml-tool-call-finder";

export interface YamlXmlProtocolOptions {
  /**
   * Whether to include a system prompt example showing YAML multiline syntax.
   * @default true
   */
  includeMultilineExample?: boolean;
}

export type ToolCallMatch = ToolCallMatchImpl;

export function findToolCalls(
  text: string,
  toolNames: string[]
): ToolCallMatch[] {
  return findToolCallsImpl(text, toolNames);
}

export function parseYamlContentForStreamProgress(
  yamlContent: string
): Record<string, unknown> | null {
  return parseYamlContentForStreamProgressImpl(yamlContent);
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
