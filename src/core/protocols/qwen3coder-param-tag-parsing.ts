import { parseQwen3CoderNamelessParamTag } from "./qwen3coder-nameless-param-parsing";
import {
  findClosingTagEnd as findClosingTagEndImpl,
  findUnclosedParamBoundaryIndex as findUnclosedParamBoundaryIndexImpl,
  toSupportedCallEndTagName as toSupportedCallEndTagNameImpl,
} from "./qwen3coder-param-tag-boundaries";
import { parseQwen3CoderToolParserParamTagNameLower } from "./qwen3coder-param-tag-name";
import type { Qwen3CoderToolParserParamTagParseResult } from "./qwen3coder-param-tag-types";
import {
  findTagEndIndex as findTagEndIndexImpl,
  getAttributeValue as getAttributeValueImpl,
  getOpeningTag as getOpeningTagImpl,
  getShorthandValue as getShorthandValueImpl,
  normalizeXmlTextValue as normalizeXmlTextValueImpl,
  parseQwen3CoderToolParserParamName,
} from "./qwen3coder-param-values";

export const findClosingTagEnd = findClosingTagEndImpl;
export const findTagEndIndex = findTagEndIndexImpl;
const findUnclosedParamBoundaryIndex = findUnclosedParamBoundaryIndexImpl;
export const toSupportedCallEndTagName = toSupportedCallEndTagNameImpl;
export const getAttributeValue = getAttributeValueImpl;
export const getOpeningTag = getOpeningTagImpl;
export const getShorthandValue = getShorthandValueImpl;
export const normalizeXmlTextValue = normalizeXmlTextValueImpl;

type ParamTagMatch = Extract<
  Qwen3CoderToolParserParamTagParseResult,
  { kind: "match" }
>;

function createSelfClosingParamMatch(
  start: number,
  openEnd: number,
  name: string
): ParamTagMatch {
  return {
    kind: "match",
    start,
    end: openEnd + 1,
    name,
    value: "",
  };
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
    return createSelfClosingParamMatch(startIndex, openEnd, paramName);
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
    return createSelfClosingParamMatch(startIndex, openEnd, paramName);
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
