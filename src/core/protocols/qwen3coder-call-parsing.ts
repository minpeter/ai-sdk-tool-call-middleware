import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { unescapeXml } from "../../rxml/utils/helpers";

import {
  buildSchemaParamNameMap,
  CALL_BLOCK_RE,
  isAsciiWhitespace,
  isTagBoundaryChar,
  LEADING_CALL_CLOSE_TAG_RE,
  NESTED_CALL_SHORTHAND_VALUE_RE,
  normalizeToolCallInnerOpenVariants,
  skipAsciiWhitespace,
  TOOL_CALL_CLOSE_RE,
  TOOL_CALL_OPEN_RE,
} from "./qwen3coder-call-syntax";
import {
  findClosingTagEnd,
  findTagEndIndex,
  getAttributeValue,
  getOpeningTag,
  getShorthandValue,
  normalizeXmlTextValue,
  parseQwen3CoderToolParserParamTagAt,
  toSupportedCallEndTagName,
} from "./qwen3coder-param-tag-parsing";

/**
 * Qwen3Coder call payload parsing and tool-name salvage.
 */
export function extractShorthandToolNameFromRaw(
  rawText: string
): string | null {
  const match = NESTED_CALL_SHORTHAND_VALUE_RE.exec(rawText);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!value) {
    return null;
  }
  const normalized = unescapeXml(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function extractFirstTagText(xml: string, tagName: string): string | null {
  const lower = xml.toLowerCase();
  const tagLower = tagName.toLowerCase();

  let index = 0;
  while (true) {
    const lt = lower.indexOf("<", index);
    if (lt === -1) {
      return null;
    }

    const i = skipAsciiWhitespace(lower, lt + 1);
    if (i >= lower.length || lower[i] === "/") {
      index = lt + 1;
      continue;
    }

    if (!lower.startsWith(tagLower, i)) {
      index = lt + 1;
      continue;
    }

    const afterName = i + tagLower.length;
    const boundary = lower[afterName] ?? "";
    if (boundary && !isTagBoundaryChar(boundary)) {
      index = lt + 1;
      continue;
    }

    const openEnd = findTagEndIndex(xml, lt);
    if (openEnd == null) {
      return null;
    }
    const contentStart = openEnd + 1;
    const close = findClosingTagEnd(lower, contentStart, tagLower);
    if (!close) {
      return null;
    }
    return normalizeXmlTextValue(xml.slice(contentStart, close.start));
  }
}

function extractToolCallInnerXml(segment: string): {
  inner: string;
  outerOpenTag: string;
} | null {
  const openMatch = TOOL_CALL_OPEN_RE.exec(segment);
  const closeMatch = TOOL_CALL_CLOSE_RE.exec(segment);
  if (!(openMatch && closeMatch)) {
    return null;
  }

  const openIndex = openMatch.index;
  const [openTag] = openMatch;
  const openEnd = openIndex + openTag.length;

  // Prefer the last closing tag to avoid early matches if nested content
  // includes a literal "</tool_call>" string.
  const closeIndex = segment.toLowerCase().lastIndexOf("</tool_call");
  if (closeIndex === -1) {
    return null;
  }
  const closeGt = segment.indexOf(">", closeIndex);
  if (closeGt === -1) {
    return null;
  }

  return {
    outerOpenTag: openTag,
    inner: segment.slice(openEnd, closeIndex),
  };
}

export function mergeParamValue(
  args: Record<string, unknown>,
  key: string,
  value: string
): void {
  const existing = args[key];
  if (existing === undefined) {
    args[key] = value;
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(value);
    return;
  }
  args[key] = [existing, value];
}

export function mergeArgsWithPartialParam(
  args: Record<string, unknown>,
  partialParam: { name: string; value: string } | null
): Record<string, unknown> {
  if (!partialParam) {
    return args;
  }

  const existing = args[partialParam.name];
  if (existing === undefined) {
    return {
      ...args,
      [partialParam.name]: partialParam.value,
    };
  }

  if (Array.isArray(existing)) {
    return {
      ...args,
      [partialParam.name]: [...existing, partialParam.value],
    };
  }

  return {
    ...args,
    [partialParam.name]: [existing, partialParam.value],
  };
}

function extractParameters(
  xml: string,
  options?: {
    callEndTagNameLower?: string | null;
    schemaParamNames?: Map<string, string> | null;
  }
): Record<string, unknown> {
  const args = Object.create(null) as Record<string, unknown>;

  const lower = xml.toLowerCase();
  let index = 0;
  while (true) {
    const lt = lower.indexOf("<", index);
    if (lt === -1) {
      break;
    }
    const parsed = parseQwen3CoderToolParserParamTagAt(xml, lower, lt, {
      allowEndOfString: true,
      callEndTagNameLower: options?.callEndTagNameLower,
      schemaParamNames: options?.schemaParamNames,
    });
    if (!parsed) {
      index = lt + 1;
      continue;
    }

    if (parsed.kind === "match") {
      mergeParamValue(args, parsed.name, parsed.value);
      index = parsed.end;
      continue;
    }

    if (parsed.kind === "skip") {
      index = parsed.end;
      continue;
    }

    index = (parsed.openEnd ?? lt) + 1;
  }

  return args;
}

export function parseSingleFunctionCallXml(
  xml: string,
  fallbackToolName: string | null,
  tools: LanguageModelV4FunctionTool[]
): { toolName: string; args: Record<string, unknown> } | null {
  const openingTag = getOpeningTag(xml);
  const toolNameAttr = openingTag
    ? getAttributeValue(openingTag, "name")
    : null;
  const shorthandName = openingTag ? getShorthandValue(openingTag) : null;
  const toolNameCandidate =
    toolNameAttr ??
    shorthandName ??
    extractFirstTagText(xml, "name") ??
    extractFirstTagText(xml, "tool_name") ??
    fallbackToolName;
  const toolName = toolNameCandidate?.trim() ?? null;
  const callEndTagNameLower = toSupportedCallEndTagName(
    openingTag ? getOpenTagNameLower(openingTag) : null
  );

  if (!toolName || toolName.trim().length === 0) {
    return null;
  }

  return {
    toolName,
    args: extractParameters(xml, {
      callEndTagNameLower,
      schemaParamNames: buildSchemaParamNameMap(toolName, tools),
    }),
  };
}

export function findImplicitCallOpenIndices(lowerText: string): number[] {
  const indices: number[] = [];
  let index = 0;
  while (true) {
    const lt = lowerText.indexOf("<", index);
    if (lt === -1) {
      break;
    }

    const i = skipAsciiWhitespace(lowerText, lt + 1);
    if (i >= lowerText.length) {
      break;
    }
    if (lowerText[i] === "/") {
      index = lt + 1;
      continue;
    }

    const tagNames = ["call", "function", "tool", "invoke"] as const;
    for (const tagName of tagNames) {
      if (!lowerText.startsWith(tagName, i)) {
        continue;
      }
      const after = i + tagName.length;
      const boundary = lowerText[after] ?? "";
      if (boundary && !isTagBoundaryChar(boundary) && boundary !== "=") {
        continue;
      }
      indices.push(lt);
      break;
    }

    index = lt + 1;
  }
  return indices;
}

function splitImplicitCallBlocks(xml: string): string[] {
  const lower = xml.toLowerCase();
  const starts = findImplicitCallOpenIndices(lower);
  if (starts.length === 0) {
    return [];
  }

  const blocks: string[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i] ?? 0;
    const end = starts[i + 1] ?? xml.length;
    blocks.push(xml.slice(start, end));
  }
  return blocks;
}

export function stripLeadingCallCloseTags(text: string): string {
  let out = text;
  while (true) {
    const match = LEADING_CALL_CLOSE_TAG_RE.exec(out);
    if (!match) {
      return out;
    }
    out = out.slice(match[0].length);
  }
}

function getOpenTagNameLower(openTag: string): string | null {
  const lowerOpenTag = openTag.toLowerCase();
  const lt = lowerOpenTag.indexOf("<");
  if (lt === -1) {
    return null;
  }

  let i = skipAsciiWhitespace(lowerOpenTag, lt + 1);
  if (i >= lowerOpenTag.length || lowerOpenTag[i] === "/") {
    return null;
  }

  const start = i;
  while (i < lowerOpenTag.length) {
    const ch = lowerOpenTag[i] ?? "";
    if (isAsciiWhitespace(ch) || ch === ">" || ch === "/" || ch === "=") {
      break;
    }
    i += 1;
  }

  const tagName = lowerOpenTag.slice(start, i);
  return tagName.length > 0 ? tagName : null;
}

export function splitImplicitCallAndTail(
  callBlock: string,
  tools: LanguageModelV4FunctionTool[]
): {
  callContent: string;
  trailingText: string;
} {
  const openingTag = getOpeningTag(callBlock);
  const openingTagName = toSupportedCallEndTagName(
    openingTag ? getOpenTagNameLower(openingTag) : null
  );
  const openingToolName = openingTag
    ? (getAttributeValue(openingTag, "name") ?? getShorthandValue(openingTag))
    : null;
  const schemaParamNames = buildSchemaParamNameMap(openingToolName, tools);
  const lowerCallBlock = callBlock.toLowerCase();
  let consumed = 0;

  if (openingTag) {
    consumed = openingTag.length;
    if (openingTagName) {
      const close = findClosingTagEnd(lowerCallBlock, consumed, openingTagName);
      if (close) {
        consumed = Math.max(consumed, close.end);
      }
    }
  }

  let index = 0;
  while (true) {
    const lt = lowerCallBlock.indexOf("<", index);
    if (lt === -1) {
      break;
    }

    const parsed = parseQwen3CoderToolParserParamTagAt(
      callBlock,
      lowerCallBlock,
      lt,
      {
        allowEndOfString: true,
        callEndTagNameLower: openingTagName,
        schemaParamNames,
      }
    );
    if (!parsed) {
      index = lt + 1;
      continue;
    }

    if (parsed.kind === "partial") {
      index = (parsed.openEnd ?? lt) + 1;
      continue;
    }

    consumed = Math.max(consumed, parsed.end);
    index = parsed.end;
  }

  const clamped = Math.max(0, Math.min(consumed, callBlock.length));
  return {
    callContent: callBlock.slice(0, clamped),
    trailingText: callBlock.slice(clamped),
  };
}

function parseQwen3CoderToolParserCallBlocks(
  blocks: string[],
  outerNameAttr: string | null,
  tools: LanguageModelV4FunctionTool[]
): Array<{ toolName: string; args: Record<string, unknown> }> | null {
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  for (const block of blocks) {
    const parsed = parseSingleFunctionCallXml(block, outerNameAttr, tools);
    if (!parsed) {
      return null;
    }
    calls.push(parsed);
  }
  return calls;
}

function parseQwen3CoderToolParserClosedMatches(
  inner: string,
  outerNameAttr: string | null,
  tools: LanguageModelV4FunctionTool[]
):
  | Array<{ toolName: string; args: Record<string, unknown> }>
  | null
  | undefined {
  const callBlockMatches = Array.from(inner.matchAll(CALL_BLOCK_RE));
  if (callBlockMatches.length === 0) {
    return;
  }

  const closedBlocks: string[] = [];
  let lastClosedEnd = 0;
  const firstClosedStart = callBlockMatches[0]?.index ?? 0;
  const leadingBlocks = splitImplicitCallBlocks(
    inner.slice(0, firstClosedStart)
  ).filter((block) => block.trim().length > 0);
  for (const match of callBlockMatches) {
    const callBlock = match[0] ?? "";
    const startIndex = match.index ?? -1;
    if (!callBlock || startIndex < 0) {
      continue;
    }
    closedBlocks.push(callBlock);
    lastClosedEnd = startIndex + callBlock.length;
  }

  const closedCalls = parseQwen3CoderToolParserCallBlocks(
    [...leadingBlocks, ...closedBlocks],
    outerNameAttr,
    tools
  );
  if (!closedCalls) {
    return null;
  }

  const trailingInner = inner.slice(lastClosedEnd);
  if (trailingInner.trim().length === 0) {
    return closedCalls;
  }

  const trailingBlocks = splitImplicitCallBlocks(trailingInner).filter(
    (b) => b.trim().length > 0
  );
  if (trailingBlocks.length === 0) {
    return closedCalls;
  }

  const trailingCalls = parseQwen3CoderToolParserCallBlocks(
    trailingBlocks,
    outerNameAttr,
    tools
  );
  if (!trailingCalls) {
    return closedCalls;
  }

  return closedCalls.concat(trailingCalls);
}

/**
 * Best-effort tool-name salvage regex covering every inner call-tag shape the
 * parser itself accepts in parseSingleFunctionCallXml / parseCallContent:
 *   - <(function|call|tool|invoke)="NAME">       shorthand, double-quoted
 *   - <(function|call|tool|invoke)='NAME'>       shorthand, single-quoted
 *   - <(function|call|tool|invoke)=NAME>         shorthand, bare
 *   - <(function|call|tool|invoke) name="NAME">  attribute, double-quoted
 *   - <(function|call|tool|invoke) name='NAME'>  attribute, single-quoted
 *   - <name>NAME</name>                          child element fallback
 *   - <tool_name>NAME</tool_name>                alternate child element fallback
 *
 * Bare-shorthand char class is `[^\s>/]` — exactly the parser's stop set in
 * parseShorthandValue (L159-165): it breaks on ASCII whitespace, `>`, or `/`
 * only. Quoted and attribute alternations are tried first, so the bare branch
 * is only reached when the value did not open with a quote — making it safe
 * to accept `'`, `"`, and `=` mid-value, matching the parser exactly.
 *
 * Keep this in sync with QWEN3CODER_TOOL_PARSER_CALL_TAG_NAMES and
 * parseShorthandValue's accepted character class.
 */
const QWEN3CODER_TOOL_NAME_SALVAGE_REGEX =
  /<(?:function|call|tool|invoke)(?:\s*=\s*"([^"]+)"|\s*=\s*'([^']+)'|\s*=\s*([^\s>/]+)|\s+name\s*=\s*"([^"]+)"|\s+name\s*=\s*'([^']+)')|<(?:name|tool_name)\b[^>]*>([\s\S]*?)<\s*\/\s*(?:name|tool_name)\s*>/i;

/**
 * @internal exported only so unit tests can exhaustively verify the salvage
 * shape coverage. Not part of the public API.
 */
export function extractQwen3CoderToolNameFromMarkup(
  markup: string
): string | undefined {
  const match = markup.match(QWEN3CODER_TOOL_NAME_SALVAGE_REGEX);
  if (!match) {
    return;
  }
  const name =
    match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6];
  if (!name) {
    return;
  }
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseQwen3CoderToolParserToolCallSegment(
  segment: string,
  tools: LanguageModelV4FunctionTool[]
): Array<{ toolName: string; args: Record<string, unknown> }> | null {
  const extracted = extractToolCallInnerXml(segment);
  if (!extracted) {
    return null;
  }

  const { outerOpenTag } = extracted;
  const inner = normalizeToolCallInnerOpenVariants(extracted.inner, tools);
  const outerNameAttr = getAttributeValue(outerOpenTag, "name");

  const closedCalls = parseQwen3CoderToolParserClosedMatches(
    inner,
    outerNameAttr,
    tools
  );
  if (closedCalls) {
    return closedCalls;
  }
  if (closedCalls === null) {
    return null;
  }

  // Some models omit the closing </function> and go straight to </tool_call>.
  // When that happens, CALL_BLOCK_RE matches nothing; fall back to splitting
  // by call-opening tags (<function=...>, etc.) and treating the next opening
  // tag or end-of-container as an implicit terminator.
  const implicitBlocks = splitImplicitCallBlocks(inner).filter(
    (b) => b.trim().length > 0
  );
  if (implicitBlocks.length > 0) {
    return parseQwen3CoderToolParserCallBlocks(
      implicitBlocks,
      outerNameAttr,
      tools
    );
  }

  const single =
    parseSingleFunctionCallXml(inner, outerNameAttr, tools) ??
    parseSingleFunctionCallXml(segment, outerNameAttr, tools);
  if (!single) {
    return null;
  }
  return [single];
}
