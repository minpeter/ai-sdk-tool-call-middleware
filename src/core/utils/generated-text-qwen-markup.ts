import { unescapeXml } from "../../rxml/utils/helpers";
import { isPrototypeSensitiveArgumentKey } from "./prototype-sensitive-keys";

export const QWEN_CALL_BLOCK_OPEN_REGEX =
  /<\s*(call|function|tool|invoke)\b[^>]*>/gi;
const QWEN_PARAM_OPEN_REGEX = /<\s*(?:parameter|param|argument|arg)\b[^>]*>/gi;
const QWEN_PARAM_BOUNDARY_REGEX =
  /<\s*(?:parameter|param|argument|arg)\b|<\s*\/\s*(?:parameter|param|argument|arg|call|function|tool|invoke)\s*>/i;
const QWEN_NAME_CHILD_REGEX =
  /<\s*(?:name|tool_name)\b[^>]*>([\s\S]*?)<\s*\/\s*(?:name|tool_name)\s*>/i;
const SELF_CLOSING_TAG_REGEX = /\/\s*>$/;
const QWEN_TAG_SHORTHAND_VALUE_REGEX =
  /^<\s*[A-Za-z_][\w.-]*\b\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>/<]+))/i;
const QWEN_NAME_ATTR_REGEX = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

export function isSelfClosingTag(openTag: string): boolean {
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

export function readQwenCallToolName(
  openTag: string,
  body: string
): string | null {
  const tagValue = readQwenTagValue(openTag);
  if (tagValue?.trim()) {
    return tagValue.trim();
  }

  const nameChild = QWEN_NAME_CHILD_REGEX.exec(body);
  const childValue = nameChild?.[1];
  return childValue?.trim() ? unescapeXml(childValue).trim() : null;
}

export function readFunctionBlockParams(
  body: string
): Record<string, unknown> | null {
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

export function findQwenCallCloseTag(
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
