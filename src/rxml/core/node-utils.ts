import type { RxmlValue } from "../builders/stringify";
import type { RXMLNode } from "./types";

function buildNodeValue(child: RXMLNode): RxmlValue {
  const kids = simplify(child.children);
  let nodeValue: RxmlValue = kids;

  // Add attributes if present
  if (Object.keys(child.attributes).length) {
    if (typeof kids === "string") {
      nodeValue = kids;
      // For string content with attributes, we need to preserve both
      if (kids === "") {
        nodeValue = { _attributes: child.attributes };
      } else {
        nodeValue = { _attributes: child.attributes, value: kids };
      }
    } else if (typeof kids === "object" && kids !== null) {
      nodeValue = { ...kids, _attributes: child.attributes };
    } else {
      nodeValue = { _attributes: child.attributes };
    }
  }

  return nodeValue;
}

/**
 * Simplify parsed XML structure (similar to TXML's simplify)
 */
export function simplify(children: (RXMLNode | string)[]): RxmlValue {
  if (!children.length) {
    return "";
  }

  if (children.length === 1 && typeof children[0] === "string") {
    return children[0];
  }

  const out: Record<string, RxmlValue> = {};

  // Map each object
  for (const child of children) {
    if (typeof child !== "object") {
      continue;
    }

    const existing = out[child.tagName];
    const nodeValue = buildNodeValue(child);
    if (Array.isArray(existing)) {
      existing.push(nodeValue);
    } else {
      out[child.tagName] = [nodeValue];
    }
  }

  // Flatten single-item arrays
  for (const key in out) {
    if (!Object.hasOwn(out, key)) {
      continue;
    }
    const value = out[key];
    if (Array.isArray(value) && value.length === 1) {
      out[key] = value[0];
    }
  }

  return out;
}

/**
 * Filter XML nodes (similar to TXML's filter)
 */
export function filter(
  children: (RXMLNode | string)[],
  filterFn: (
    node: RXMLNode,
    index: number,
    currentDepth: number,
    currentPath: string
  ) => boolean,
  depth = 0,
  path = ""
): RXMLNode[] {
  const out: RXMLNode[] = [];

  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (typeof child === "object" && filterFn(child, i, depth, path)) {
      out.push(child);
    }
    if (typeof child === "object" && child.children) {
      const childPath = `${path ? `${path}.` : ""}${i}.${child.tagName}`;
      const kids = filter(child.children, filterFn, depth + 1, childPath);
      out.push(...kids);
    }
  }

  return out;
}
