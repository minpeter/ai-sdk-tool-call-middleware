import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";

/**
 * Qwen3Coder call syntax, malformed opener normalization, and streaming
 * prefix handling shared by generated-text and streaming parsers.
 */
export const TOOL_CALL_OPEN_RE = /<tool_call\b[^>]*>/i;
export const TOOL_CALL_CLOSE_RE = /<\/tool_call\s*>/i;
const TOOL_CALL_CLOSE_TRAILING_RE = /<\/tool_call\s*>\s*$/i;
export const TOOL_CALL_BLOCK_RE =
  /<tool_call\b[^>]*>[\s\S]*?<\/tool_call\s*>/gi;
export const LEADING_CALL_CLOSE_TAG_RE =
  /^\s*<\s*\/\s*(?:tool_call|function|call|tool|invoke)\s*>/i;

export const CALL_BLOCK_RE =
  /<(call|function|tool|invoke)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

export const QWEN3CODER_TOOL_PARSER_PARAM_TAG_NAMES = new Set([
  "parameter",
  "param",
  "argument",
  "arg",
]);

export const QWEN3CODER_TOOL_PARSER_CALL_TAG_NAMES = new Set([
  "function",
  "call",
  "tool",
  "invoke",
  "tool_call",
]);

export const CALL_SHORTHAND_VALUE_RE =
  /^<\s*(call|function|tool|invoke)\b\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>/<]+))/i;
export const NESTED_CALL_SHORTHAND_VALUE_RE =
  /<\s*(?:call|function|tool|invoke)\b\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>/<]+))/i;

// Non-global variants for streaming parsing (avoids `lastIndex` state).
export const QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_START_RE =
  /<\s*(?!\/)\s*(call|function|tool|invoke)\b/i;
export const QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_TAG_RE =
  /<\s*(?!\/)\s*(call|function|tool|invoke)\b[^>]*>/i;
export const QWEN3CODER_TOOL_PARSER_STREAM_TOOL_CALL_CLOSE_TAG_RE =
  /<\s*\/\s*tool_call\s*>/i;
export const QWEN3CODER_TOOL_PARSER_STREAM_NAME_OR_PARAM_SIGNAL_RE =
  /<\s*(?!\/)\s*(name|tool_name|parameter|param|argument|arg)\b/i;
export const QWEN3CODER_TOOL_PARSER_STREAM_NAME_TAG_RE =
  /<\s*(name|tool_name)\b[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/i;
export const QWEN3CODER_TOOL_PARSER_STREAM_SELF_CLOSING_TAG_RE = /\/\s*>$/;
/** Whitespace and complete tag-like tokens only (salvage strictness gate). */
export const SALVAGE_MARKUP_ONLY_TEXT_REGEX = /^\s*(?:<[^<>\n]*>\s*)*$/;

/**
 * Tag names that must never be treated as schema-property parameter tags,
 * because the parser assigns them structural meaning.
 */
const QWEN3CODER_RESERVED_TAG_NAMES = new Set([
  ...QWEN3CODER_TOOL_PARSER_PARAM_TAG_NAMES,
  ...QWEN3CODER_TOOL_PARSER_CALL_TAG_NAMES,
  "tool_call",
  "name",
  "tool_name",
]);

/**
 * Builds a lowercase → canonical map of the resolved tool's schema property
 * names. Live models (observed on Qwen2.5 and GLM-4.7) frequently emit
 * parameters as bare property-named tags (`<path>…</path>`) instead of the
 * canonical `<parameter=path>…</parameter>`; matching against the schema keys
 * lets the parser accept that variant without misreading arbitrary markup.
 */
export function buildSchemaParamNameMap(
  toolName: string | null | undefined,
  tools: LanguageModelV4FunctionTool[]
): Map<string, string> | null {
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
  const map = new Map<string, string>();
  for (const key of Object.keys(properties)) {
    const lower = key.toLowerCase();
    if (!QWEN3CODER_RESERVED_TAG_NAMES.has(lower)) {
      map.set(lower, key);
    }
  }
  return map.size > 0 ? map : null;
}

/**
 * `<function>NAME</function>` — the tool name emitted as element text with an
 * immediate close (observed live on Llama 3.1 8B under the Qwen prompt).
 */
const CALL_NAME_AS_TEXT_VARIANT_RE =
  /^(\s*)<(function|call|tool|invoke)\s*>\s*([A-Za-z_][\w.-]{0,255})\s*<\s*\/\s*\2\s*>/i;

/**
 * `function=NAME>` — the call open tag missing its leading `<` (observed live
 * on GLM-4.7).
 */
const CALL_OPEN_MISSING_LT_VARIANT_RE =
  /^(\s*)(function|call|tool|invoke)\s*=\s*"?([A-Za-z_][\w.-]{0,255})"?\s*>?/i;

/**
 * `NAME` or `NAME>` directly after `<tool_call>` (observed live on GLM-4.7).
 * Only rewritten when NAME exactly matches a declared tool, so ordinary prose
 * inside a tool_call block is never misread as a call opener.
 */
const CALL_OPEN_BARE_NAME_VARIANT_RE =
  /^(\s*)([A-Za-z_][\w.-]{0,255})\s*>?[ \t]*(?=\r?\n|<)/;

/**
 * Rewrites malformed call-open variants at the start of a tool_call body to
 * the canonical `<function=NAME>` form so the regular parse paths can handle
 * them. Returns the input unchanged when no variant matches.
 */
export function normalizeToolCallInnerOpenVariants(
  inner: string,
  tools: LanguageModelV4FunctionTool[]
): string {
  const nameAsText = CALL_NAME_AS_TEXT_VARIANT_RE.exec(inner);
  if (nameAsText) {
    const [full, leading = "", tagName = "function", name = ""] = nameAsText;
    if (name) {
      return `${leading}<${tagName.toLowerCase()}=${name}>${inner.slice(full.length)}`;
    }
  }

  const missingLt = CALL_OPEN_MISSING_LT_VARIANT_RE.exec(inner);
  if (missingLt) {
    const [full, leading = "", tagName = "function", name = ""] = missingLt;
    if (name) {
      return `${leading}<${tagName.toLowerCase()}=${name}>${inner.slice(full.length)}`;
    }
  }

  const bareName = CALL_OPEN_BARE_NAME_VARIANT_RE.exec(inner);
  if (bareName) {
    const [full, leading = "", name = ""] = bareName;
    if (name && tools.some((t) => t.name === name)) {
      return `${leading}<function=${name}>${inner.slice(full.length)}`;
    }
  }

  return inner;
}

/**
 * A tool_call body that could still become the `<function>NAME</function>`
 * name-as-text variant once more chunks arrive: an open call tag, an optional
 * identifier, and an optional partial closing tag. Used to defer streaming
 * mode decisions until the shape is resolved.
 */
const CALL_OPEN_TAG_ONLY_PARTIAL_RE = /^\s*<(?:function|call|tool|invoke)$/i;

const CALL_OPEN_BARE_IDENTIFIER_PARTIAL_RE = /^\s*([A-Za-z_][\w.-]{0,255})>?$/;

const CALL_NAME_AS_TEXT_PARTIAL_RE =
  /^\s*<(?:function|call|tool|invoke)\s*>\s*(?:[A-Za-z_][\w.-]{0,255})?\s*(?:<(?:\s*\/(?:\s*[A-Za-z_]{0,12})?)?)?$/i;

/**
 * A tool_call body that could still become the `function=NAME>` missing-`<`
 * variant once more chunks arrive.
 */
const CALL_OPEN_MISSING_LT_PARTIAL_RE =
  /^\s*(?:function|call|tool|invoke)(?:\s*=\s*"?(?:[A-Za-z_][\w.-]{0,255})?"?)?$/i;

type StreamCallOpenNormalization =
  | { status: "unchanged" }
  | { status: "rewritten"; value: string }
  | { status: "incomplete" };

/**
 * Streaming-safe wrapper around normalizeToolCallInnerOpenVariants: rewrites
 * only when the malformed opener is fully determined, and reports
 * `incomplete` while the buffered prefix could still become one of the
 * variants (so the caller defers its mode decision instead of misparsing).
 */
export function normalizeStreamToolCallInnerOpenVariants(
  inner: string,
  tools: LanguageModelV4FunctionTool[]
): StreamCallOpenNormalization {
  // Incomplete-prefix checks come first: a truncated `function=se…` tail must
  // wait for more chunks rather than be rewritten with a truncated name.
  // `<function` at buffer end is also held: the next character decides between
  // canonical `<function=…>` and the `<function>NAME</function>` variant.
  if (
    CALL_OPEN_TAG_ONLY_PARTIAL_RE.test(inner) ||
    CALL_NAME_AS_TEXT_PARTIAL_RE.test(inner) ||
    CALL_OPEN_MISSING_LT_PARTIAL_RE.test(inner)
  ) {
    return { status: "incomplete" };
  }

  const bareIdentifier = CALL_OPEN_BARE_IDENTIFIER_PARTIAL_RE.exec(inner);
  if (bareIdentifier) {
    const partialName = bareIdentifier[1] ?? "";
    if (tools.some((t) => t.name.startsWith(partialName))) {
      return { status: "incomplete" };
    }
  }

  const rewritten = normalizeToolCallInnerOpenVariants(inner, tools);
  if (rewritten !== inner) {
    return { status: "rewritten", value: rewritten };
  }

  return { status: "unchanged" };
}

/**
 * Tag openers/closers whose partial prefix must never leak into streamed
 * tool-input deltas while the closing markup is still arriving.
 */
const TRAILING_WHITESPACE_RE = /\s+$/u;

const QWEN3CODER_PROGRESS_HOLDBACK_TAG_PREFIXES = [
  "</parameter>",
  "</param>",
  "</argument>",
  "</arg>",
  "</function>",
  "</call>",
  "</tool>",
  "</invoke>",
  "</tool_call>",
  "<parameter=",
  "<param=",
  "<argument=",
  "<arg=",
];

/**
 * Returns the earliest index where the value's tail could be the beginning of
 * one of the candidate tags, or null when the tail cannot start any of them.
 */
function trailingPotentialTagStartIndex(
  lowerValue: string,
  candidates: readonly string[]
): number | null {
  let cut: number | null = null;
  for (const candidate of candidates) {
    const maxLen = Math.min(candidate.length - 1, lowerValue.length);
    for (let len = maxLen; len > 0; len -= 1) {
      if (lowerValue.endsWith(candidate.slice(0, len))) {
        const index = lowerValue.length - len;
        if (cut === null || index < cut) {
          cut = index;
        }
        break;
      }
    }
  }
  return cut;
}

/**
 * Streaming progress deltas must only contain value text that is certain to
 * survive final parsing: a trailing run that could still turn into a closing
 * tag (`</parameter…`) and boundary whitespace (trimmed by
 * normalizeXmlTextValue on the final pass) are held back until resolved.
 */
export function sanitizePartialParamValueForProgress(
  partial: { name: string; value: string } | null,
  extraHoldbackTags: readonly string[]
): { name: string; value: string } | null {
  if (!partial) {
    return null;
  }
  let { value } = partial;
  const cut = trailingPotentialTagStartIndex(value.toLowerCase(), [
    ...QWEN3CODER_PROGRESS_HOLDBACK_TAG_PREFIXES,
    ...extraHoldbackTags,
  ]);
  if (cut !== null) {
    value = value.slice(0, cut);
  }
  value = value.replace(TRAILING_WHITESPACE_RE, "");
  // A trailing lone high surrogate (a chunk boundary split an emoji) would be
  // JSON-escaped now but emitted raw once paired, breaking delta extension.
  const lastCode = value.charCodeAt(value.length - 1);
  if (lastCode >= 0xd8_00 && lastCode <= 0xdb_ff) {
    value = value.slice(0, -1);
  }
  return value === partial.value ? partial : { name: partial.name, value };
}

export function isAsciiWhitespace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === "\f";
}

export function skipAsciiWhitespace(text: string, index: number): number {
  let i = index;
  while (i < text.length && isAsciiWhitespace(text[i] ?? "")) {
    i += 1;
  }
  return i;
}

export function stripLeadingToolCallCloseTags(text: string): string {
  let out = text;
  while (true) {
    const start = skipAsciiWhitespace(out, 0);
    const trimmed = out.slice(start);
    const match = TOOL_CALL_CLOSE_RE.exec(trimmed);
    if (match?.index !== 0 || !match[0]) {
      return out;
    }
    out = out.slice(start + match[0].length);
  }
}

export function stripTrailingToolCallCloseTags(text: string): string {
  let out = text;
  while (true) {
    const next = out.replace(TOOL_CALL_CLOSE_TRAILING_RE, "");
    if (next === out) {
      return out;
    }
    out = next;
  }
}

export function isTagBoundaryChar(ch: string): boolean {
  return ch === "" || isAsciiWhitespace(ch) || ch === ">" || ch === "/";
}

export function isTagNameBoundaryChar(ch: string | undefined): boolean {
  return (
    ch === undefined ||
    isAsciiWhitespace(ch) ||
    ch === ">" ||
    ch === "/" ||
    ch === "="
  );
}

/**
 * Like `getPotentialStartIndex`, but tag-shape aware: a complete occurrence
 * of the prefix counts only when followed by a valid tag-name boundary, so
 * ordinary text such as `<callback>` or `<toolbar>` does not pin the stream
 * buffer until finish. A trailing partial occurrence is still reported so a
 * real tag split across chunks is never flushed as text prematurely.
 */
export function getPotentialTagStartIndex(
  lower: string,
  prefixLower: string
): number | null {
  let from = 0;
  while (true) {
    const index = lower.indexOf(prefixLower, from);
    if (index === -1) {
      break;
    }
    if (isTagNameBoundaryChar(lower[index + prefixLower.length])) {
      return index;
    }
    from = index + 1;
  }

  // Genuine trailing partial: the buffer tail is a proper prefix of the tag.
  // Scanned directly (longest first) because an earlier boundary-invalid full
  // occurrence (e.g. `<tool_callback>`) must not mask a real partial at the
  // end of the buffer.
  const maxLen = Math.min(prefixLower.length - 1, lower.length);
  for (let len = maxLen; len > 0; len -= 1) {
    if (lower.endsWith(prefixLower.slice(0, len))) {
      return lower.length - len;
    }
  }
  return null;
}
