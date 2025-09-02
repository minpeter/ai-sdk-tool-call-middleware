/**
 * Raw content extraction utilities for string-typed properties
 * This replaces the string-based extraction with DOM-based extraction
 */

import type { RXMLNode } from "../core/types";
import {
  isNameChar,
  isNameStartChar,
  parseName,
  skipQuoted,
} from "../utils/helpers";

/**
 * Extract raw inner content from XML string for a specific tag
 * This is used for string-typed properties to preserve exact content
 */
export function extractRawInner(
  xmlContent: string,
  tagName: string
): string | undefined {
  const len = xmlContent.length;
  const target = tagName;
  let bestStart = -1;
  let bestEnd = -1;
  let bestDepth = Number.POSITIVE_INFINITY;

  let i = 0;
  let depth = 0;

  while (i < len) {
    const lt = xmlContent.indexOf("<", i);
    if (lt === -1) return undefined;
    i = lt + 1;
    if (i >= len) return undefined;

    const ch = xmlContent[i];
    if (ch === "!") {
      // Handle DOCTYPE declarations specially - treat them as regular content
      // when they appear within tag content, not as XML declarations
      if (xmlContent.startsWith("!DOCTYPE", i + 1)) {
        // For DOCTYPE within content, we need to find the closing >
        const gt = xmlContent.indexOf(">", i + 1);
        i = gt === -1 ? len : gt + 1;
        continue;
      }
      if (xmlContent.startsWith("!--", i + 1)) {
        const close = xmlContent.indexOf("-->", i + 4);
        i = close === -1 ? len : close + 3;
        continue;
      }
      if (xmlContent.startsWith("![CDATA[", i + 1)) {
        const close = xmlContent.indexOf("]]>", i + 9);
        i = close === -1 ? len : close + 3;
        continue;
      }
      const gt = xmlContent.indexOf(">", i + 1);
      i = gt === -1 ? len : gt + 1;
      continue;
    } else if (ch === "?") {
      const close = xmlContent.indexOf("?>", i + 1);
      i = close === -1 ? len : close + 2;
      continue;
    } else if (ch === "/") {
      const gt = xmlContent.indexOf(">", i + 1);
      i = gt === -1 ? len : gt + 1;
      depth = Math.max(0, depth - 1);
      continue;
    } else {
      let j = i;
      if (j < len && isNameStartChar(xmlContent[j])) {
        j++;
        while (j < len && isNameChar(xmlContent[j])) j++;
      }
      const name = xmlContent.slice(i, j);
      let k = j;
      let isSelfClosing = false;

      while (k < len) {
        const c = xmlContent[k];
        if (c === '"' || c === "'") {
          k = skipQuoted(xmlContent, k);
          continue;
        }
        if (c === ">") break;
        if (c === "/" && xmlContent[k + 1] === ">") {
          isSelfClosing = true;
          k++;
          break;
        }
        k++;
      }

      const tagEnd = k;
      if (name === target) {
        const contentStart =
          xmlContent[tagEnd] === ">" ? tagEnd + 1 : tagEnd + 1;

        if (isSelfClosing) {
          if (depth < bestDepth) {
            bestStart = contentStart;
            bestEnd = contentStart;
            bestDepth = depth;
          }
        } else {
          let pos = contentStart;
          let sameDepth = 1;

          while (pos < len) {
            const nextLt = xmlContent.indexOf("<", pos);
            if (nextLt === -1) break;
            const nx = nextLt + 1;
            if (nx >= len) break;

            const h = xmlContent[nx];
            if (h === "!") {
              // Special handling for DOCTYPE and other declarations within content
              if (xmlContent.startsWith("!DOCTYPE", nx + 1)) {
                const gt2 = xmlContent.indexOf(">", nx + 1);
                pos = gt2 === -1 ? len : gt2 + 1;
                continue;
              }
              if (xmlContent.startsWith("!--", nx + 1)) {
                const close = xmlContent.indexOf("-->", nx + 4);
                pos = close === -1 ? len : close + 3;
                continue;
              }
              if (xmlContent.startsWith("![CDATA[", nx + 1)) {
                const close = xmlContent.indexOf("]]>", nx + 9);
                pos = close === -1 ? len : close + 3;
                continue;
              }
              const gt2 = xmlContent.indexOf(">", nx + 1);
              pos = gt2 === -1 ? len : gt2 + 1;
              continue;
            } else if (h === "?") {
              const close = xmlContent.indexOf("?>", nx + 1);
              pos = close === -1 ? len : close + 2;
              continue;
            } else if (h === "/") {
              let t = nx + 1;
              if (t < len && isNameStartChar(xmlContent[t])) {
                t++;
                while (t < len && isNameChar(xmlContent[t])) t++;
              }
              const endName = xmlContent.slice(nx + 1, t);
              const gt2 = xmlContent.indexOf(">", t);
              if (endName === target) {
                sameDepth--;
                if (sameDepth === 0) {
                  if (depth < bestDepth) {
                    bestStart = contentStart;
                    bestEnd = nextLt;
                    bestDepth = depth;
                  }
                  break;
                }
              }
              pos = gt2 === -1 ? len : gt2 + 1;
              continue;
            } else {
              let t = nx;
              if (t < len && isNameStartChar(xmlContent[t])) {
                t++;
                while (t < len && isNameChar(xmlContent[t])) t++;
              }
              let u = t;
              let isSelfClosingNested = false;
              while (u < len) {
                const cu = xmlContent[u];
                if (cu === '"' || cu === "'") {
                  u = skipQuoted(xmlContent, u);
                  continue;
                }
                if (cu === ">") break;
                if (cu === "/" && xmlContent[u + 1] === ">") {
                  isSelfClosingNested = true;
                  u++;
                  break;
                }
                u++;
              }
              const startName = xmlContent.slice(nx, t);
              if (startName === target && !isSelfClosingNested) {
                sameDepth++;
              }
              pos = xmlContent[u] === ">" ? u + 1 : u + 1;
              continue;
            }
          }
        }
      }
      i = xmlContent[tagEnd] === ">" ? tagEnd + 1 : tagEnd + 1;
      depth += isSelfClosing ? 0 : 1;
      continue;
    }
  }

  if (bestStart !== -1) {
    return xmlContent.slice(bestStart, bestEnd);
  }
  return undefined;
}

/**
 * Find all inner content ranges for a given tag name at any depth.
 * Returns ranges for the inner content between <tagName ...> and </tagName>.
 */
export function findAllInnerRanges(
  xmlContent: string,
  tagName: string
): Array<{ start: number; end: number }> {
  const len = xmlContent.length;
  const target = tagName;
  const ranges: Array<{ start: number; end: number }> = [];

  let i = 0;

  while (i < len) {
    const lt = xmlContent.indexOf("<", i);
    if (lt === -1) break;
    i = lt + 1;
    if (i >= len) break;

    const ch = xmlContent[i];
    if (ch === "!") {
      if (xmlContent.startsWith("!--", i + 1)) {
        const close = xmlContent.indexOf("-->", i + 4);
        i = close === -1 ? len : close + 3;
        continue;
      }
      if (xmlContent.startsWith("![CDATA[", i + 1)) {
        const close = xmlContent.indexOf("]]>", i + 9);
        i = close === -1 ? len : close + 3;
        continue;
      }
      // DOCTYPE or other declaration
      const gt = xmlContent.indexOf(">", i + 1);
      i = gt === -1 ? len : gt + 1;
      continue;
    }
    if (ch === "?") {
      const close = xmlContent.indexOf("?>", i + 1);
      i = close === -1 ? len : close + 2;
      continue;
    }
    if (ch === "/") {
      const gt = xmlContent.indexOf(">", i + 1);
      i = gt === -1 ? len : gt + 1;
      continue;
    }

    // Opening tag
    let j = i;
    if (j < len && isNameStartChar(xmlContent[j])) {
      j++;
      while (j < len && isNameChar(xmlContent[j])) j++;
    }
    const name = xmlContent.slice(i, j);
    let k = j;
    let isSelfClosing = false;
    while (k < len) {
      const c = xmlContent[k];
      if (c === '"' || c === "'") {
        k = skipQuoted(xmlContent, k);
        continue;
      }
      if (c === ">") break;
      if (c === "/" && xmlContent[k + 1] === ">") {
        isSelfClosing = true;
        k++;
        break;
      }
      k++;
    }
    const tagEnd = k;

    if (name !== target) {
      // Advance over this tag
      i = xmlContent[tagEnd] === ">" ? tagEnd + 1 : tagEnd + 1;
      continue;
    }

    // Found a target start tag
    const contentStart = xmlContent[tagEnd] === ">" ? tagEnd + 1 : tagEnd + 1;
    if (isSelfClosing) {
      ranges.push({ start: contentStart, end: contentStart });
      i = contentStart; // continue after this position
      continue;
    }

    // Find matching close tag at same depth for this occurrence
    let pos = contentStart;
    let sameDepth = 1;
    while (pos < len) {
      const nextLt = xmlContent.indexOf("<", pos);
      if (nextLt === -1) break;
      const nx = nextLt + 1;
      if (nx >= len) break;

      const h = xmlContent[nx];
      if (h === "!") {
        if (xmlContent.startsWith("!--", nx + 1)) {
          const close = xmlContent.indexOf("-->", nx + 4);
          pos = close === -1 ? len : close + 3;
          continue;
        }
        if (xmlContent.startsWith("![CDATA[", nx + 1)) {
          const close = xmlContent.indexOf("]]>", nx + 9);
          pos = close === -1 ? len : close + 3;
          continue;
        }
        const gt2 = xmlContent.indexOf(">", nx + 1);
        pos = gt2 === -1 ? len : gt2 + 1;
        continue;
      } else if (h === "?") {
        const close = xmlContent.indexOf("?>", nx + 1);
        pos = close === -1 ? len : close + 2;
        continue;
      } else if (h === "/") {
        let t = nx + 1;
        if (t < len && isNameStartChar(xmlContent[t])) {
          t++;
          while (t < len && isNameChar(xmlContent[t])) t++;
        }
        const endName = xmlContent.slice(nx + 1, t);
        const gt2 = xmlContent.indexOf(">", t);
        if (endName === target) {
          sameDepth--;
          if (sameDepth === 0) {
            ranges.push({ start: contentStart, end: nextLt });
            // advance i to after this closing tag
            i = gt2 === -1 ? len : gt2 + 1;
            break;
          }
        }
        pos = gt2 === -1 ? len : gt2 + 1;
        continue;
      } else {
        let t = nx;
        if (t < len && isNameStartChar(xmlContent[t])) {
          t++;
          while (t < len && isNameChar(xmlContent[t])) t++;
        }
        let u = t;
        let isSelfClosingNested = false;
        while (u < len) {
          const cu = xmlContent[u];
          if (cu === '"' || cu === "'") {
            u = skipQuoted(xmlContent, u);
            continue;
          }
          if (cu === ">") break;
          if (cu === "/" && xmlContent[u + 1] === ">") {
            isSelfClosingNested = true;
            u++;
            break;
          }
          u++;
        }
        const startName = xmlContent.slice(nx, t);
        if (startName === target && !isSelfClosingNested) {
          sameDepth++;
        }
        pos = xmlContent[u] === ">" ? u + 1 : u + 1;
        continue;
      }
    }

    if (sameDepth !== 0) {
      // unmatched; stop scanning further to avoid infinite loops
      break;
    }
  }

  return ranges;
}

/**
 * Find the first top-level range for a tag
 */
export function findFirstTopLevelRange(
  xmlContent: string,
  tagName: string
): { start: number; end: number } | undefined {
  const len = xmlContent.length;
  const target = tagName;

  let i = 0;
  let depth = 0;

  while (i < len) {
    const lt = xmlContent.indexOf("<", i);
    if (lt === -1) return undefined;
    i = lt + 1;
    if (i >= len) return undefined;

    const ch = xmlContent[i];
    if (ch === "!") {
      // Handle DOCTYPE declarations specially - treat them as regular content
      // when they appear within tag content, not as XML declarations
      if (xmlContent.startsWith("!DOCTYPE", i + 1)) {
        // For DOCTYPE within content, we need to find the closing >
        const gt = xmlContent.indexOf(">", i + 1);
        i = gt === -1 ? len : gt + 1;
        continue;
      }
      if (xmlContent.startsWith("!--", i + 1)) {
        const close = xmlContent.indexOf("-->", i + 4);
        i = close === -1 ? len : close + 3;
        continue;
      }
      if (xmlContent.startsWith("![CDATA[", i + 1)) {
        const close = xmlContent.indexOf("]]>", i + 9);
        i = close === -1 ? len : close + 3;
        continue;
      }
      const gt = xmlContent.indexOf(">", i + 1);
      i = gt === -1 ? len : gt + 1;
      continue;
    } else if (ch === "?") {
      const close = xmlContent.indexOf("?>", i + 1);
      i = close === -1 ? len : close + 2;
      continue;
    } else if (ch === "/") {
      const gt = xmlContent.indexOf(">", i + 1);
      i = gt === -1 ? len : gt + 1;
      depth = Math.max(0, depth - 1);
      continue;
    } else {
      let j = i;
      if (j < len && isNameStartChar(xmlContent[j])) {
        j++;
        while (j < len && isNameChar(xmlContent[j])) j++;
      }
      const name = xmlContent.slice(i, j);
      let k = j;
      let isSelfClosing = false;

      while (k < len) {
        const c = xmlContent[k];
        if (c === '"' || c === "'") {
          k = skipQuoted(xmlContent, k);
          continue;
        }
        if (c === ">") break;
        if (c === "/" && xmlContent[k + 1] === ">") {
          isSelfClosing = true;
          k++;
          break;
        }
        k++;
      }

      const tagEnd = k;
      if (depth === 0 && name === target) {
        const contentStart =
          xmlContent[tagEnd] === ">" ? tagEnd + 1 : tagEnd + 1;
        if (isSelfClosing) return { start: contentStart, end: contentStart };

        let pos = contentStart;
        let sameDepth = 1;
        while (pos < len) {
          const nextLt = xmlContent.indexOf("<", pos);
          if (nextLt === -1) break;
          const nx = nextLt + 1;
          if (nx >= len) break;

          const h = xmlContent[nx];
          if (h === "!") {
            // Special handling for DOCTYPE and other declarations within content
            if (xmlContent.startsWith("!DOCTYPE", nx + 1)) {
              const gt2 = xmlContent.indexOf(">", nx + 1);
              pos = gt2 === -1 ? len : gt2 + 1;
              continue;
            }
            if (xmlContent.startsWith("!--", nx + 1)) {
              const close = xmlContent.indexOf("-->", nx + 4);
              pos = close === -1 ? len : close + 3;
              continue;
            }
            if (xmlContent.startsWith("![CDATA[", nx + 1)) {
              const close = xmlContent.indexOf("]]>", nx + 9);
              pos = close === -1 ? len : close + 3;
              continue;
            }
            const gt2 = xmlContent.indexOf(">", nx + 1);
            pos = gt2 === -1 ? len : gt2 + 1;
            continue;
          } else if (h === "?") {
            const close = xmlContent.indexOf("?>", nx + 1);
            pos = close === -1 ? len : close + 2;
            continue;
          } else if (h === "/") {
            let t = nx + 1;
            if (t < len && isNameStartChar(xmlContent[t])) {
              t++;
              while (t < len && isNameChar(xmlContent[t])) t++;
            }
            const endName = xmlContent.slice(nx + 1, t);
            const gt2 = xmlContent.indexOf(">", t);
            if (endName === target) {
              sameDepth--;
              if (sameDepth === 0) {
                return { start: contentStart, end: nextLt };
              }
            }
            pos = gt2 === -1 ? len : gt2 + 1;
            continue;
          } else {
            let t = nx;
            if (t < len && isNameStartChar(xmlContent[t])) {
              t++;
              while (t < len && isNameChar(xmlContent[t])) t++;
            }
            const startName = xmlContent.slice(nx, t);
            let u = t;
            let isSelfClosingNested = false;
            while (u < len) {
              const cu = xmlContent[u];
              if (cu === '"' || cu === "'") {
                u = skipQuoted(xmlContent, u);
                continue;
              }
              if (cu === ">") break;
              if (cu === "/" && xmlContent[u + 1] === ">") {
                isSelfClosingNested = true;
                u++;
                break;
              }
              u++;
            }
            // Track nested opening tags with the same name so we only end when
            // the matching top-level closing tag is reached
            if (startName === target && !isSelfClosingNested) {
              sameDepth++;
            }
            pos = xmlContent[u] === ">" ? u + 1 : u + 1;
            continue;
          }
        }
        return undefined;
      }
      i = xmlContent[tagEnd] === ">" ? tagEnd + 1 : tagEnd + 1;
      depth += isSelfClosing ? 0 : 1;
      continue;
    }
  }
  return undefined;
}

/**
 * Count tag occurrences, excluding specified ranges
 */
export function countTagOccurrences(
  xmlContent: string,
  tagName: string,
  excludeRanges?: Array<{ start: number; end: number }>,
  shouldSkipFirst: boolean = true
): number {
  const len = xmlContent.length;
  const target = tagName;

  let i = 0;
  let count = 0;
  let skipFirstLocal = shouldSkipFirst;
  const isExcluded = (pos: number): boolean => {
    if (!excludeRanges || excludeRanges.length === 0) return false;
    for (const r of excludeRanges) {
      if (pos >= r.start && pos < r.end) return true;
    }
    return false;
  };

  while (i < len) {
    const lt = xmlContent.indexOf("<", i);
    if (lt === -1) break;
    i = lt + 1;
    if (i >= len) break;

    const ch = xmlContent[i];
    if (ch === "!") {
      if (xmlContent.startsWith("!--", i + 1)) {
        const close = xmlContent.indexOf("-->", i + 4);
        i = close === -1 ? len : close + 3;
        continue;
      }
      if (xmlContent.startsWith("![CDATA[", i + 1)) {
        const close = xmlContent.indexOf("]]>", i + 9);
        i = close === -1 ? len : close + 3;
        continue;
      }
      const gt = xmlContent.indexOf(">", i + 1);
      i = gt === -1 ? len : gt + 1;
      continue;
    } else if (ch === "?") {
      const close = xmlContent.indexOf("?>", i + 1);
      i = close === -1 ? len : close + 2;
      continue;
    } else if (ch === "/") {
      const gt = xmlContent.indexOf(">", i + 1);
      i = gt === -1 ? len : gt + 1;
      continue;
    } else {
      let j = i;
      if (j < len && isNameStartChar(xmlContent[j])) {
        j++;
        while (j < len && isNameChar(xmlContent[j])) j++;
      }
      const name = xmlContent.slice(i, j);
      let k = j;
      while (k < len) {
        const c = xmlContent[k];
        if (c === '"' || c === "'") {
          k = skipQuoted(xmlContent, k);
          continue;
        }
        if (c === ">") break;
        if (c === "/" && xmlContent[k + 1] === ">") {
          k++;
          break;
        }
        k++;
      }
      if (name === target && !isExcluded(lt)) {
        if (skipFirstLocal) {
          skipFirstLocal = false;
        } else {
          count++;
        }
      }
      i = k + 1;
      continue;
    }
  }

  return count;
}

/**
 * Find all top-level ranges for a tag (for handling duplicates)
 */
export function findAllTopLevelRanges(
  xmlContent: string,
  tagName: string
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const len = xmlContent.length;
  const target = tagName;
  let i = 0;
  let depth = 0;

  while (i < len) {
    const lt = xmlContent.indexOf("<", i);
    if (lt === -1) break;
    i = lt + 1;
    if (i >= len) break;

    const ch = xmlContent[i];
    if (ch === "!") {
      // Handle DOCTYPE declarations specially - treat them as regular content
      // when they appear within tag content, not as XML declarations
      if (xmlContent.startsWith("!DOCTYPE", i + 1)) {
        // For DOCTYPE within content, we need to find the closing >
        const gt = xmlContent.indexOf(">", i + 1);
        i = gt === -1 ? len : gt + 1;
        continue;
      }
      if (xmlContent.startsWith("!--", i + 1)) {
        const close = xmlContent.indexOf("-->", i + 4);
        i = close === -1 ? len : close + 3;
        continue;
      }
      if (xmlContent.startsWith("![CDATA[", i + 1)) {
        const close = xmlContent.indexOf("]]>", i + 9);
        i = close === -1 ? len : close + 3;
        continue;
      }
      const gt = xmlContent.indexOf(">", i + 1);
      i = gt === -1 ? len : gt + 1;
      continue;
    } else if (ch === "?") {
      const close = xmlContent.indexOf("?>", i + 1);
      i = close === -1 ? len : close + 2;
      continue;
    } else if (ch === "/") {
      // Closing tag
      i++;
      const { name, newPos } = parseName(xmlContent, i);
      if (name === target) depth--;
      i = xmlContent.indexOf(">", newPos);
      if (i === -1) break;
      i++;
      continue;
    }

    // Opening tag
    const { name, newPos } = parseName(xmlContent, i);
    i = newPos;

    // Skip attributes
    let k = i;
    while (k < len && xmlContent[k] !== ">") {
      const c = xmlContent[k];
      if (c === '"' || c === "'") {
        k = skipQuoted(xmlContent, k);
        continue;
      }
      if (c === "/" && xmlContent[k + 1] === ">") {
        k++;
        break;
      }
      k++;
    }

    if (name === target && depth === 0) {
      // Found a top-level occurrence
      const tagStart = lt;
      const isSelfClosing =
        xmlContent[k] === "/" || xmlContent.startsWith("/>", k);

      if (isSelfClosing) {
        ranges.push({
          start: tagStart,
          end: k + (xmlContent[k] === "/" ? 2 : 1),
        });
      } else {
        // Find the closing tag
        depth++;
        let closeDepth = 1;
        let j = k + 1;

        while (j < len && closeDepth > 0) {
          const nextLt = xmlContent.indexOf("<", j);
          if (nextLt === -1) break;

          if (xmlContent[nextLt + 1] === "/") {
            const { name: closeName } = parseName(xmlContent, nextLt + 2);
            if (closeName === target) closeDepth--;
          } else if (
            xmlContent[nextLt + 1] !== "!" &&
            xmlContent[nextLt + 1] !== "?"
          ) {
            const { name: openName } = parseName(xmlContent, nextLt + 1);
            if (openName === target) closeDepth++;
          }

          j = xmlContent.indexOf(">", nextLt + 1);
          if (j === -1) break;
          j++;
        }

        if (closeDepth === 0) {
          ranges.push({ start: tagStart, end: j });
        }
        depth--;
      }
    }

    i = k + 1;
  }

  return ranges;
}

/**
 * Extract raw content from DOM node
 */
export function extractRawFromNode(node: RXMLNode): string {
  if (node.children.length === 0) return "";
  if (node.children.length === 1 && typeof node.children[0] === "string") {
    return node.children[0];
  }

  // For complex content, concatenate all text nodes
  let result = "";
  for (const child of node.children) {
    if (typeof child === "string") {
      result += child;
    } else {
      result += extractRawFromNode(child);
    }
  }
  return result;
}
