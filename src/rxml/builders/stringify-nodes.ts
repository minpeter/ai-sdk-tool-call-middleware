import type { RXMLNode, StringifyOptions } from "../core/types";
import {
  escapeXml,
  escapeXmlMinimalAttr,
  escapeXmlMinimalText,
} from "../utils/helpers";

interface NodeStringifyOptions {
  readonly indent: string;
  readonly minimalEscaping: boolean;
  readonly newline: string;
  readonly strictBooleanAttributes: boolean;
}

type NodeOptions = Pick<
  StringifyOptions,
  "strictBooleanAttributes" | "minimalEscaping"
>;

function formatNodeAttribute(
  attrName: string,
  attrValue: string | null,
  options: NodeStringifyOptions
): string {
  if (attrValue === null) {
    return options.strictBooleanAttributes
      ? ` ${attrName}="${attrName}"`
      : ` ${attrName}`;
  }

  if (attrValue.indexOf('"') === -1) {
    const escaped = options.minimalEscaping
      ? escapeXmlMinimalAttr(attrValue, '"')
      : escapeXml(attrValue);
    return ` ${attrName}="${escaped}"`;
  }

  const escaped = options.minimalEscaping
    ? escapeXmlMinimalAttr(attrValue, "'")
    : escapeXml(attrValue);
  return ` ${attrName}='${escaped}'`;
}

function buildNodeOpeningTag(
  node: RXMLNode,
  options: NodeStringifyOptions
): string {
  let result = `${options.indent}<${node.tagName}`;
  for (const [attrName, attrValue] of Object.entries(node.attributes)) {
    result += formatNodeAttribute(attrName, attrValue, options);
  }
  return result;
}

function stringifyNodeChildren(options: {
  readonly children: (RXMLNode | string)[];
  readonly depth: number;
  readonly format: boolean;
  readonly stringifyOptions: NodeOptions;
  readonly minimalEscaping: boolean;
  readonly newline: string;
}): { readonly content: string; readonly hasElementChildren: boolean } {
  let content = "";
  let hasElementChildren = false;

  for (const child of options.children) {
    if (typeof child === "string") {
      content += options.minimalEscaping
        ? escapeXmlMinimalText(child)
        : escapeXml(child);
    } else {
      if (!hasElementChildren && options.format) {
        content += options.newline;
        hasElementChildren = true;
      }
      content += stringifyNode(
        child,
        options.depth + 1,
        options.format,
        options.stringifyOptions
      );
    }
  }

  return { content, hasElementChildren };
}

export function stringifyNode(
  node: RXMLNode,
  depth = 0,
  format = true,
  options: NodeOptions = {}
): string {
  const indent = format ? "  ".repeat(depth) : "";
  const newline = format ? "\n" : "";
  const minimalEscaping = options.minimalEscaping ?? false;
  const strictBooleanAttributes = options.strictBooleanAttributes ?? false;
  const nodeOptions: NodeStringifyOptions = {
    minimalEscaping,
    strictBooleanAttributes,
    indent,
    newline,
  };

  let result = buildNodeOpeningTag(node, nodeOptions);
  if (node.tagName[0] === "?") {
    return `${result}?>${newline}`;
  }
  if (node.children.length === 0) {
    return `${result}/>${newline}`;
  }

  result += ">";
  const { content, hasElementChildren } = stringifyNodeChildren({
    children: node.children,
    depth,
    format,
    stringifyOptions: options,
    minimalEscaping,
    newline,
  });
  result += content;
  if (hasElementChildren && format) {
    result += indent;
  }
  result += `</${node.tagName}>`;
  if (format) {
    result += newline;
  }
  return result;
}

export function stringifyNodes(
  nodes: (RXMLNode | string)[],
  format = true,
  options: NodeOptions = {}
): string {
  let result = "";
  for (const node of nodes) {
    result +=
      typeof node === "string" ? node : stringifyNode(node, 0, format, options);
  }
  return result;
}

export function toContentString(nodes: (RXMLNode | string)[]): string {
  let result = "";
  for (const node of nodes) {
    result +=
      typeof node === "string"
        ? ` ${node}`
        : ` ${toContentString(node.children)}`;
    result = result.trim();
  }
  return result;
}
