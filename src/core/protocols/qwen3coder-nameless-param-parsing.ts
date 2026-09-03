import { escapeRegExp } from "../utils/regex";
import {
  findClosingTagEnd,
  findUnclosedParamBoundaryIndex,
} from "./qwen3coder-param-tag-boundaries";
import type { Qwen3CoderToolParserParamTagParseResult } from "./qwen3coder-param-tag-types";
import { normalizeXmlTextValue } from "./qwen3coder-param-values";

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

/**
 * Salvage the nameless-tag variant some models (e.g. Qwen2.5) emit when they
 * half-follow the format:
 *
 *   <parameter>city</parameter>
 *   Seoul
 *
 * The element text is the parameter NAME and the plain text after the closing
 * tag (up to the next parameter tag or call close boundary) is the VALUE.
 * Only identifier-like element text qualifies, so ordinary tagged content is
 * not misread as a parameter.
 */
export function parseQwen3CoderNamelessParamTag(options: {
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
    // The closing tag may still be streaming in.
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
        // Schema coercion can rewrite an incomplete nameless value (notably a
        // JSON array or number), so only previously completed parameters are
        // safe to stream. The current value is emitted once its boundary is
        // known. Schema-less legacy salvage keeps its historical progress.
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
