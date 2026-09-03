import {
  isAsciiWhitespace,
  QWEN3CODER_TOOL_PARSER_PARAM_TAG_NAMES,
  skipAsciiWhitespace,
} from "./qwen3coder-call-syntax";

export function parseQwen3CoderToolParserParamTagNameLower(
  lowerText: string,
  startIndex: number,
  schemaParamNames?: Map<string, string> | null
):
  | { kind: "match"; tagNameLower: string; isSchemaParam: boolean }
  | { kind: "partial" }
  | null {
  let i = skipAsciiWhitespace(lowerText, startIndex + 1);
  if (i >= lowerText.length) {
    return { kind: "partial" };
  }
  if (lowerText[i] === "/") {
    return null;
  }

  const nameStart = i;
  while (i < lowerText.length) {
    const ch = lowerText[i] ?? "";
    if (isAsciiWhitespace(ch) || ch === ">" || ch === "/" || ch === "=") {
      break;
    }
    i += 1;
  }

  const tagNameLower = lowerText.slice(nameStart, i);
  if (QWEN3CODER_TOOL_PARSER_PARAM_TAG_NAMES.has(tagNameLower)) {
    return { kind: "match", tagNameLower, isSchemaParam: false };
  }
  if (schemaParamNames?.has(tagNameLower)) {
    return { kind: "match", tagNameLower, isSchemaParam: true };
  }
  return null;
}
