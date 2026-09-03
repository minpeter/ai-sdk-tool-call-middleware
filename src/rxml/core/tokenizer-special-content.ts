import type { RXMLNode } from "./types";
import { CharCodes } from "./types";

interface SpecialContentResult {
  readonly newPosition: number;
  readonly nodes: (RXMLNode | string)[];
}

function readComment(
  xmlString: string,
  position: number,
  keepComments: boolean
): SpecialContentResult {
  const startCommentPosition = position;
  let endPosition = position;

  while (
    endPosition !== -1 &&
    !(
      xmlString.charCodeAt(endPosition) === CharCodes.CLOSE_BRACKET &&
      xmlString.charCodeAt(endPosition - 1) === CharCodes.MINUS &&
      xmlString.charCodeAt(endPosition - 2) === CharCodes.MINUS
    )
  ) {
    endPosition = xmlString.indexOf(">", endPosition + 1);
  }

  if (endPosition === -1) {
    endPosition = xmlString.length;
  }

  return {
    newPosition: endPosition + 1,
    nodes: keepComments
      ? [xmlString.slice(startCommentPosition, endPosition + 1)]
      : [],
  };
}

function readCData(xmlString: string, position: number): SpecialContentResult {
  const cdataEndIndex = xmlString.indexOf("]]>", position);
  if (cdataEndIndex === -1) {
    return {
      newPosition: xmlString.length,
      nodes: [xmlString.slice(position + 9)],
    };
  }
  return {
    newPosition: cdataEndIndex + 3,
    nodes: [xmlString.slice(position + 9, cdataEndIndex)],
  };
}

function readDoctype(
  xmlString: string,
  position: number
): SpecialContentResult {
  const startDoctype = position + 1;
  let cursor = position + 2;
  let encapsulated = false;

  while (
    (xmlString.charCodeAt(cursor) !== CharCodes.CLOSE_BRACKET ||
      encapsulated) &&
    xmlString[cursor]
  ) {
    if (xmlString.charCodeAt(cursor) === CharCodes.OPEN_CORNER_BRACKET) {
      encapsulated = true;
    } else if (
      encapsulated &&
      xmlString.charCodeAt(cursor) === CharCodes.CLOSE_CORNER_BRACKET
    ) {
      encapsulated = false;
    }
    cursor += 1;
  }

  return {
    newPosition: cursor + 1,
    nodes: [xmlString.slice(startDoctype, cursor)],
  };
}

export function readSpecialContent(
  xmlString: string,
  position: number,
  keepComments: boolean
): SpecialContentResult {
  if (xmlString.charCodeAt(position + 2) === CharCodes.MINUS) {
    return readComment(xmlString, position, keepComments);
  }
  if (
    xmlString.charCodeAt(position + 2) === CharCodes.OPEN_CORNER_BRACKET &&
    xmlString.charCodeAt(position + 8) === CharCodes.OPEN_CORNER_BRACKET &&
    xmlString.slice(position + 3, position + 8).toLowerCase() === "cdata"
  ) {
    return readCData(xmlString, position);
  }
  return readDoctype(xmlString, position);
}
