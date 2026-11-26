import { escapeRegExp } from "../../../shared/regex";
import { unescapeXml } from "../../../shared/xml-escape";
import {
  isAsciiWhitespace,
  QWEN3CODER_TOOL_PARSER_PARAM_TAG_NAMES,
  skipAsciiWhitespace,
} from "./call-syntax";
import {
  findClosingTagEnd,
  findTagEndIndex,
  findUnclosedParamBoundaryIndex,
  getAttributeValue,
  normalizeXmlTextValue,
  parseShorthandValue,
} from "./param-tag-primitives";

type Qwen3CoderToolParserParamTagParseResult =
  | {
      kind: "match";
      start: number;
      end: number;
      name: string;
      value: string;
    }
  | {
      kind: "partial";
      start: number;
      openEnd: number | null;
      name?: string;
      value?: string;
    }
  | {
      kind: "skip";
      start: number;
      end: number;
    };

function parseQwen3CoderToolParserParamName(
  openTag: string,
  tagNameLower: string
): string | null {
  const shorthand = parseShorthandValue(openTag, tagNameLower);
  if (shorthand != null) {
    return unescapeXml(shorthand);
  }

  return getAttributeValue(openTag, "name");
}

function parseQwen3CoderToolParserParamTagNameLower(
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

function parseQwen3CoderToolParserUnclosedParamValue(options: {
  text: string;
  lowerText: string;
  startIndex: number;
  openEnd: number;
  paramName: string;
  allowEndOfString: boolean;
  callEndTagNameLower?: string | null;
  schemaParamNames?: Map<string, string> | null;
}): Qwen3CoderToolParserParamTagParseResult {
  const valueStart = options.openEnd + 1;
  const boundaryIndex = findUnclosedParamBoundaryIndex(
    options.lowerText,
    valueStart,
    options.callEndTagNameLower ?? null,
    options.allowEndOfString,
    options.schemaParamNames
  );
  if (boundaryIndex == null) {
    if (!options.allowEndOfString) {
      const rawProgressValue = options.text.slice(valueStart);
      return {
        kind: "partial",
        start: options.startIndex,
        openEnd: options.openEnd,
        name: options.paramName,
        value: rawProgressValue ? normalizeXmlTextValue(rawProgressValue) : "",
      };
    }

    const rawValue = options.text.slice(valueStart);
    return {
      kind: "match",
      start: options.startIndex,
      end: options.text.length,
      name: options.paramName,
      value: rawValue ? normalizeXmlTextValue(rawValue) : "",
    };
  }

  const rawValue = options.text.slice(valueStart, boundaryIndex);
  return {
    kind: "match",
    start: options.startIndex,
    end: boundaryIndex,
    name: options.paramName,
    value: rawValue ? normalizeXmlTextValue(rawValue) : "",
  };
}

function parseQwen3CoderToolParserSchemaParamTag(options: {
  text: string;
  lowerText: string;
  startIndex: number;
  openEnd: number;
  tagNameLower: string;
  paramName: string;
  selfClosing: boolean;
  allowEndOfString: boolean;
  callEndTagNameLower?: string | null;
  schemaParamNames?: Map<string, string> | null;
}): Qwen3CoderToolParserParamTagParseResult {
  const { text, lowerText, startIndex, openEnd, tagNameLower, paramName } =
    options;

  if (options.selfClosing) {
    return {
      kind: "match",
      start: startIndex,
      end: openEnd + 1,
      name: paramName,
      value: "",
    };
  }

  const valueStart = openEnd + 1;
  const close = findClosingTagEnd(lowerText, valueStart, tagNameLower);
  if (close) {
    const rawValue = text.slice(valueStart, close.start);
    return {
      kind: "match",
      start: startIndex,
      end: close.end,
      name: paramName,
      value: rawValue ? normalizeXmlTextValue(rawValue) : "",
    };
  }

  return parseQwen3CoderToolParserUnclosedParamValue({
    text,
    lowerText,
    startIndex,
    openEnd,
    paramName,
    allowEndOfString: options.allowEndOfString,
    callEndTagNameLower: options.callEndTagNameLower,
    schemaParamNames: options.schemaParamNames,
  });
}

const NAMELESS_PARAM_IDENTIFIER_RE = /^[A-Za-z_][\w.-]{0,255}$/;
const redundantNamelessParamCloseTagCache = new Map<string, RegExp>();

function stripRedundantNamelessParamValueClose(options: {
  rawValue: string;
  paramName: string;
  tagNameLower: string;
  schemaParamNames?: Map<string, string> | null;
}): string {
  if (!options.schemaParamNames?.has(options.paramName.toLowerCase())) {
    return options.rawValue;
  }

  let closeAtEnd = redundantNamelessParamCloseTagCache.get(
    options.tagNameLower
  );
  if (!closeAtEnd) {
    closeAtEnd = new RegExp(
      `<\\s*\\/\\s*${escapeRegExp(options.tagNameLower)}\\s*>\\s*$`,
      "i"
    );
    redundantNamelessParamCloseTagCache.set(options.tagNameLower, closeAtEnd);
  }

  const match = closeAtEnd.exec(options.rawValue);
  if (!match || match.index === undefined) {
    return options.rawValue;
  }
  return options.rawValue.slice(0, match.index);
}

function isSchemaBackedNamelessParam(
  paramName: string,
  schemaParamNames?: Map<string, string> | null
): boolean {
  return schemaParamNames?.has(paramName.toLowerCase()) === true;
}

function parseQwen3CoderNamelessParamTag(options: {
  text: string;
  lowerText: string;
  startIndex: number;
  openEnd: number;
  tagNameLower: string;
  allowEndOfString: boolean;
  callEndTagNameLower?: string | null;
  schemaParamNames?: Map<string, string> | null;
}): Qwen3CoderToolParserParamTagParseResult | null {
  const { text, lowerText, startIndex, openEnd, tagNameLower } = options;

  const nameStart = openEnd + 1;
  const close = findClosingTagEnd(lowerText, nameStart, tagNameLower);
  if (!close) {
    return options.allowEndOfString
      ? null
      : { kind: "partial", start: startIndex, openEnd };
  }

  const paramName = normalizeXmlTextValue(text.slice(nameStart, close.start));
  if (!NAMELESS_PARAM_IDENTIFIER_RE.test(paramName)) {
    return null;
  }

  const valueStart = close.end;
  const boundaryIndex = findUnclosedParamBoundaryIndex(
    lowerText,
    valueStart,
    options.callEndTagNameLower ?? null,
    options.allowEndOfString,
    options.schemaParamNames
  );
  if (boundaryIndex == null) {
    if (!options.allowEndOfString) {
      const rawProgressValue = stripRedundantNamelessParamValueClose({
        rawValue: text.slice(valueStart),
        paramName,
        tagNameLower,
        schemaParamNames: options.schemaParamNames,
      });
      return {
        kind: "partial",
        start: startIndex,
        openEnd,
        ...(isSchemaBackedNamelessParam(paramName, options.schemaParamNames)
          ? {}
          : {
              name: paramName,
              value: rawProgressValue
                ? normalizeXmlTextValue(rawProgressValue)
                : "",
            }),
      };
    }

    const rawValue = stripRedundantNamelessParamValueClose({
      rawValue: text.slice(valueStart),
      paramName,
      tagNameLower,
      schemaParamNames: options.schemaParamNames,
    });
    return {
      kind: "match",
      start: startIndex,
      end: text.length,
      name: paramName,
      value: rawValue ? normalizeXmlTextValue(rawValue) : "",
    };
  }

  const rawValue = stripRedundantNamelessParamValueClose({
    rawValue: text.slice(valueStart, boundaryIndex),
    paramName,
    tagNameLower,
    schemaParamNames: options.schemaParamNames,
  });
  return {
    kind: "match",
    start: startIndex,
    end: boundaryIndex,
    name: paramName,
    value: rawValue ? normalizeXmlTextValue(rawValue) : "",
  };
}

export function parseQwen3CoderToolParserParamTagAt(
  text: string,
  lowerText: string,
  startIndex: number,
  options?: {
    allowEndOfString?: boolean;
    callEndTagNameLower?: string | null;
    schemaParamNames?: Map<string, string> | null;
  }
): Qwen3CoderToolParserParamTagParseResult | null {
  const tagNameParse = parseQwen3CoderToolParserParamTagNameLower(
    lowerText,
    startIndex,
    options?.schemaParamNames
  );
  if (!tagNameParse) {
    return null;
  }
  if (tagNameParse.kind === "partial") {
    return { kind: "partial", start: startIndex, openEnd: null };
  }

  const { tagNameLower } = tagNameParse;

  const openEnd = findTagEndIndex(text, startIndex);
  if (openEnd == null) {
    return { kind: "partial", start: startIndex, openEnd: null };
  }

  const openTag = text.slice(startIndex, openEnd + 1);

  if (tagNameParse.isSchemaParam) {
    return parseQwen3CoderToolParserSchemaParamTag({
      text,
      lowerText,
      startIndex,
      openEnd,
      tagNameLower,
      paramName: options?.schemaParamNames?.get(tagNameLower) ?? tagNameLower,
      selfClosing: openTag.trimEnd().endsWith("/>"),
      allowEndOfString: options?.allowEndOfString === true,
      callEndTagNameLower: options?.callEndTagNameLower,
      schemaParamNames: options?.schemaParamNames,
    });
  }
  const paramNameRaw = parseQwen3CoderToolParserParamName(
    openTag,
    tagNameLower
  );
  const paramName = paramNameRaw?.trim() ?? "";
  const selfClosing = openTag.trimEnd().endsWith("/>");
  if (selfClosing && paramName.length === 0) {
    return {
      kind: "skip",
      start: startIndex,
      end: openEnd + 1,
    };
  }
  if (paramName.length === 0) {
    return parseQwen3CoderNamelessParamTag({
      text,
      lowerText,
      startIndex,
      openEnd,
      tagNameLower,
      allowEndOfString: options?.allowEndOfString === true,
      callEndTagNameLower: options?.callEndTagNameLower,
      schemaParamNames: options?.schemaParamNames,
    });
  }

  if (selfClosing) {
    return {
      kind: "match",
      start: startIndex,
      end: openEnd + 1,
      name: paramName,
      value: "",
    };
  }

  const valueStart = openEnd + 1;
  const close = findClosingTagEnd(lowerText, valueStart, tagNameLower);
  if (!close) {
    return parseQwen3CoderToolParserUnclosedParamValue({
      text,
      lowerText,
      startIndex,
      openEnd,
      paramName,
      allowEndOfString: options?.allowEndOfString === true,
      callEndTagNameLower: options?.callEndTagNameLower,
      schemaParamNames: options?.schemaParamNames,
    });
  }

  const rawValue = text.slice(openEnd + 1, close.start);
  return {
    kind: "match",
    start: startIndex,
    end: close.end,
    name: paramName,
    value: rawValue ? normalizeXmlTextValue(rawValue) : "",
  };
}
