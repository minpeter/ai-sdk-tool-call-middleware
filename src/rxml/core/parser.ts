import {
  parseWithoutSchema as parseFragment,
  parseNode as parseSingleNode,
} from "./fragment-parser";
import { filter as filterNodes, simplify as simplifyNodes } from "./node-utils";
import { parse as parseWithSchema } from "./schema-parser";
import type { ParseOptions, RXMLNode } from "./types";

export const filter = filterNodes;
export const simplify = simplifyNodes;

export function parse(
  xmlInner: string,
  schema: unknown,
  options: ParseOptions = {}
): Record<string, unknown> {
  return parseWithSchema(xmlInner, schema, options);
}

export function parseWithoutSchema(
  xmlString: string,
  options: ParseOptions = {}
): (RXMLNode | string)[] {
  return parseFragment(xmlString, options);
}

export function parseNode(
  xmlString: string,
  options: ParseOptions = {}
): RXMLNode {
  return parseSingleNode(xmlString, options);
}
