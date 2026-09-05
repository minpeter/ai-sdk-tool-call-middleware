import {
  isTagBoundaryChar,
  isTagNameBoundaryChar,
  QWEN3CODER_TOOL_PARSER_CALL_TAG_NAMES,
  skipAsciiWhitespace,
} from "./qwen3coder-call-syntax";

function getCdataSectionNextIndex(
  textLower: string,
  startIndex: number
): number | null {
  if (!textLower.startsWith("<![cdata[", startIndex)) {
    return startIndex;
  }
  const cdataEnd = textLower.indexOf("]]>", startIndex + "<![cdata[".length);
  if (cdataEnd === -1) {
    return null;
  }
  return cdataEnd + 3;
}

function parseMatchingTagHeader(
  textLower: string,
  lt: number,
  tagNameLower: string
): { isClosing: boolean; afterName: number } | null {
  let i = skipAsciiWhitespace(textLower, lt + 1);
  const isClosing = textLower[i] === "/";
  if (isClosing) {
    i += 1;
    i = skipAsciiWhitespace(textLower, i);
  }
  if (!textLower.startsWith(tagNameLower, i)) {
    return null;
  }

  const afterName = i + tagNameLower.length;
  const boundary = textLower[afterName] ?? "";
  const validBoundary = isClosing
    ? isTagBoundaryChar(boundary)
    : isTagBoundaryChar(boundary) || boundary === "=";
  if (boundary && !validBoundary) {
    return null;
  }

  return { isClosing, afterName };
}

function isSelfClosingXmlTag(
  textLower: string,
  lt: number,
  gt: number
): boolean {
  return textLower
    .slice(lt, gt + 1)
    .trimEnd()
    .endsWith("/>");
}

export function findClosingTagEnd(
  textLower: string,
  startIndex: number,
  tagNameLower: string
): { start: number; end: number } | null {
  let depth = 1;
  let index = startIndex;
  while (true) {
    const lt = textLower.indexOf("<", index);
    if (lt === -1) {
      return null;
    }

    const cdataNextIndex = getCdataSectionNextIndex(textLower, lt);
    if (cdataNextIndex == null) {
      return null;
    }
    if (cdataNextIndex !== lt) {
      index = cdataNextIndex;
      continue;
    }

    const header = parseMatchingTagHeader(textLower, lt, tagNameLower);
    if (!header) {
      index = lt + 1;
      continue;
    }

    const gt = textLower.indexOf(">", header.afterName);
    if (gt === -1) {
      return null;
    }

    if (header.isClosing) {
      depth -= 1;
      if (depth === 0) {
        return { start: lt, end: gt + 1 };
      }
      index = gt + 1;
      continue;
    }

    const isSelfClosing = isSelfClosingXmlTag(textLower, lt, gt);
    if (!isSelfClosing) {
      depth += 1;
    }
    index = gt + 1;
  }
}

function findClosingTagStartWithBoundary(
  lowerText: string,
  valueStart: number,
  tagNameLower: string,
  allowEndOfStringBoundary: boolean
): number {
  const needle = `</${tagNameLower}`;
  let searchIndex = valueStart;

  while (searchIndex < lowerText.length) {
    const found = lowerText.indexOf(needle, searchIndex);
    if (found === -1) {
      return -1;
    }
    const nextChar = lowerText[found + needle.length] ?? "";
    if (nextChar === "" && !allowEndOfStringBoundary) {
      searchIndex = found + needle.length;
      continue;
    }
    if (isTagBoundaryChar(nextChar)) {
      return found;
    }
    searchIndex = found + needle.length;
  }

  return -1;
}

export function toSupportedCallEndTagName(
  tagNameLower: string | null | undefined
): string | null {
  const normalized = tagNameLower?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return null;
  }
  return QWEN3CODER_TOOL_PARSER_CALL_TAG_NAMES.has(normalized)
    ? normalized
    : null;
}

// vLLM reference (Qwen3CoderToolParser): tolerate missing </parameter> by treating
// the next <parameter=...> / </function> boundary as an implicit close.
// https://github.com/vllm-project/vllm/blob/f13e86d8ddf81c638bacce6f8876cf6acf421d58/vllm/tool_parsers/qwen3coder_tool_parser.py#L65-L68
// https://github.com/vllm-project/vllm/blob/f13e86d8ddf81c638bacce6f8876cf6acf421d58/vllm/tool_parsers/qwen3coder_tool_parser.py#L612-L636
// https://github.com/vllm-project/vllm/blob/f13e86d8ddf81c638bacce6f8876cf6acf421d58/tests/tool_parsers/test_qwen3coder_tool_parser.py#L686-L764
function indexOfTagOpenWithBoundary(
  lowerText: string,
  fromIndex: number,
  tagNameLower: string
): number {
  const needle = `<${tagNameLower}`;
  let from = fromIndex;
  while (true) {
    const index = lowerText.indexOf(needle, from);
    if (index === -1) {
      return -1;
    }
    if (isTagNameBoundaryChar(lowerText[index + needle.length])) {
      return index;
    }
    from = index + 1;
  }
}

export function findUnclosedParamBoundaryIndex(
  lowerText: string,
  valueStart: number,
  callEndTagNameLower: string | null,
  allowEndOfString: boolean,
  schemaParamNames?: Map<string, string> | null
): number | null {
  const normalizedCallEndTag = toSupportedCallEndTagName(callEndTagNameLower);
  const callCloseIndex = normalizedCallEndTag
    ? findClosingTagStartWithBoundary(
        lowerText,
        valueStart,
        normalizedCallEndTag,
        allowEndOfString
      )
    : findClosingTagStartWithBoundary(
        lowerText,
        valueStart,
        "function",
        allowEndOfString
      );

  const indices = [
    indexOfTagOpenWithBoundary(lowerText, valueStart, "parameter"),
    indexOfTagOpenWithBoundary(lowerText, valueStart, "param"),
    indexOfTagOpenWithBoundary(lowerText, valueStart, "argument"),
    indexOfTagOpenWithBoundary(lowerText, valueStart, "arg"),
    callCloseIndex,
    findClosingTagStartWithBoundary(
      lowerText,
      valueStart,
      "tool_call",
      allowEndOfString
    ),
    indexOfTagOpenWithBoundary(lowerText, valueStart, "function"),
    indexOfTagOpenWithBoundary(lowerText, valueStart, "call"),
    indexOfTagOpenWithBoundary(lowerText, valueStart, "tool"),
    indexOfTagOpenWithBoundary(lowerText, valueStart, "invoke"),
  ].filter((index) => index !== -1);

  if (schemaParamNames) {
    for (const nameLower of schemaParamNames.keys()) {
      const index = indexOfTagOpenWithBoundary(
        lowerText,
        valueStart,
        nameLower
      );
      if (index !== -1) {
        indices.push(index);
      }
    }
  }

  if (indices.length === 0) {
    return null;
  }
  return Math.min(...indices);
}
