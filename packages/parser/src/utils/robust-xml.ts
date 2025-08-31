import { XMLParser } from "fast-xml-parser";
import { XMLBuilder } from "fast-xml-parser";

import { coerceBySchema, getSchemaType, unwrapJsonSchema } from "./coercion";
import type { OnErrorFn } from "./on-error";

export interface Options {
  textNodeName?: string;
  throwOnDuplicateStringTags?: boolean;
  onError?: OnErrorFn;
}

export class RXMLParseError extends Error {
  constructor(
    message: string,
    public cause?: unknown
  ) {
    super(message);
    this.name = "RXMLParseError";
  }
}

export class RXMLDuplicateStringTagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RXMLDuplicateStringTagError";
  }
}

export class RXMLCoercionError extends Error {
  constructor(
    message: string,
    public cause?: unknown
  ) {
    super(message);
    this.name = "RXMLCoercionError";
  }
}

export class RXMLStringifyError extends Error {
  constructor(
    message: string,
    public cause?: unknown
  ) {
    super(message);
    this.name = "RXMLStringifyError";
  }
}

function getPropertySchema(toolSchema: unknown, key: string): unknown {
  const unwrapped = unwrapJsonSchema(toolSchema);
  if (!unwrapped || typeof unwrapped !== "object") return undefined;
  const u = unwrapped as Record<string, unknown>;
  const props = u.properties as Record<string, unknown> | undefined;
  if (props && Object.prototype.hasOwnProperty.call(props, key)) {
    return (props as Record<string, unknown>)[key];
  }
  return undefined;
}

export function extractRawInner(
  xmlContent: string,
  tagName: string
): string | undefined {
  const isNameStartChar = (ch: string): boolean => /[A-Za-z_:]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_.:-]/.test(ch);
  const len = xmlContent.length;
  const target = tagName;
  let bestStart = -1;
  let bestEnd = -1;
  let bestDepth = Number.POSITIVE_INFINITY;

  const skipQuoted = (s: string, i: number): number => {
    const quote = s[i];
    i++;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) return i + 1;
      i++;
    }
    return i;
  };

  let i = 0;
  let depth = 0;
  while (i < len) {
    const lt = xmlContent.indexOf("<", i);
    if (lt === -1) return undefined;
    i = lt + 1;
    if (i >= len) return undefined;
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

export function findFirstTopLevelRange(
  xmlContent: string,
  tagName: string
): { start: number; end: number } | undefined {
  const isNameStartChar = (ch: string): boolean => /[A-Za-z_:]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_.:-]/.test(ch);
  const len = xmlContent.length;
  const target = tagName;
  const skipQuoted = (s: string, i: number): number => {
    const quote = s[i];
    i++;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) return i + 1;
      i++;
    }
    return i;
  };

  let i = 0;
  let depth = 0;
  while (i < len) {
    const lt = xmlContent.indexOf("<", i);
    if (lt === -1) return undefined;
    i = lt + 1;
    if (i >= len) return undefined;
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
            if (!isSelfClosingNested) {
              // nested tag encountered; ignore for range calculation
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

export function countTagOccurrences(
  xmlContent: string,
  tagName: string,
  excludeRanges?: Array<{ start: number; end: number }>,
  skipFirst: boolean = true
): number {
  const isNameStartChar = (ch: string): boolean => /[A-Za-z_:]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_.:-]/.test(ch);
  const len = xmlContent.length;
  const target = tagName;
  const skipQuoted = (s: string, i: number): number => {
    const quote = s[i];
    i++;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) return i + 1;
      i++;
    }
    return i;
  };

  let i = 0;
  let count = 0;
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
        if (skipFirst) {
          skipFirst = false;
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

export function parse(
  xmlInner: string,
  schema: unknown,
  options?: Options
): Record<string, unknown> {
  const textNodeName = options?.textNodeName ?? "#text";
  const throwDup = options?.throwOnDuplicateStringTags ?? true;

  // Identify string-typed properties to allow placeholder sanitization
  const stringTypedProps: Set<string> = (() => {
    const set = new Set<string>();
    const unwrapped = unwrapJsonSchema(schema);
    if (unwrapped && typeof unwrapped === "object") {
      const u = unwrapped as Record<string, unknown>;
      const props = u.properties as Record<string, unknown> | undefined;
      if (props && typeof props === "object") {
        for (const key of Object.keys(props)) {
          const t = getSchemaType((props as Record<string, unknown>)[key]);
          if (t === "string") set.add(key);
        }
      }
    }
    return set;
  })();

  // Replace inner content of string-typed tags with placeholders to avoid
  // XML parsing errors from constructs like <!DOCTYPE ...> within element bodies
  let xmlInnerForParsing = xmlInner;
  try {
    const ranges: Array<{ start: number; end: number; key: string }> = [];
    for (const key of stringTypedProps) {
      const r = findFirstTopLevelRange(xmlInner, key);
      if (r && r.end > r.start) ranges.push({ ...r, key });
    }
    if (ranges.length > 0) {
      ranges.sort((a, b) => a.start - b.start);
      let rebuilt = "";
      let cursor = 0;
      for (const r of ranges) {
        if (cursor < r.start) rebuilt += xmlInner.slice(cursor, r.start);
        rebuilt += `__RXML_PLACEHOLDER_${r.key}__`;
        cursor = r.end;
      }
      if (cursor < xmlInner.length) rebuilt += xmlInner.slice(cursor);
      xmlInnerForParsing = rebuilt;
    }
  } catch (error) {
    // Non-fatal: fall back to original XML; allow caller to handle via onError
    if (options?.onError) {
      options.onError(
        "RXML: Failed to replace string placeholders, falling back to original XML.",
        { error }
      );
    }
    xmlInnerForParsing = xmlInner;
  }

  let parsedArgs: Record<string, unknown> = {};
  try {
    const xmlParser = new XMLParser({
      ignoreAttributes: false,
      parseTagValue: false,
      ignoreDeclaration: true,
      textNodeName,
    });
    parsedArgs = (xmlParser.parse(`<root>${xmlInnerForParsing}</root>`)?.root ||
      {}) as Record<string, unknown>;
  } catch (cause) {
    throw new RXMLParseError("Failed to parse XML", cause);
  }

  const args: Record<string, unknown> = {};
  // stringTypedProps computed above

  for (const k of Object.keys(parsedArgs || {})) {
    const v = parsedArgs[k];
    let val: unknown = v;
    const propSchema = getPropertySchema(schema, k);
    const propType = getSchemaType(propSchema);

    if (propType === "string" && !Array.isArray(v)) {
      const excludeRanges: Array<{ start: number; end: number }> = [];
      for (const other of stringTypedProps) {
        if (other === k) continue;
        const range = findFirstTopLevelRange(xmlInner, other);
        if (range) excludeRanges.push(range);
      }
      const occurrences = countTagOccurrences(xmlInner, k, excludeRanges, true);
      if (occurrences > 0 && throwDup) {
        throw new RXMLDuplicateStringTagError(
          `Duplicate string tags for <${k}> detected`
        );
      }
      if (occurrences > 0 && !throwDup && options?.onError) {
        options.onError(
          `RXML: Duplicate string tags for <${k}> detected; using first occurrence.`,
          { tag: k, occurrences }
        );
      }
      const raw = extractRawInner(xmlInner, k);
      if (typeof raw === "string") {
        args[k] = raw;
        continue;
      }
    }

    if (
      v &&
      typeof v === "object" &&
      Object.prototype.hasOwnProperty.call(v, textNodeName)
    ) {
      val = (v as Record<string, unknown>)[textNodeName as "#text"];
    }

    if (Array.isArray(v)) {
      if (propType === "string") {
        const mapped = v.map(item => {
          if (
            item &&
            typeof item === "object" &&
            Object.prototype.hasOwnProperty.call(item, textNodeName)
          ) {
            const textVal = (item as Record<string, unknown>)[
              textNodeName as "#text"
            ];
            return typeof textVal === "string" ? textVal : String(textVal);
          }
          return typeof item === "string" ? item : String(item);
        });

        if (mapped.length > 1 && throwDup) {
          throw new RXMLDuplicateStringTagError(
            `Duplicate string tags for <${k}> detected`
          );
        }
        if (mapped.length > 1 && !throwDup && options?.onError) {
          options.onError(
            `RXML: Duplicate string tags for <${k}> detected; using first occurrence.`,
            { tag: k, occurrences: mapped.length }
          );
        }

        args[k] = mapped[0] ?? "";
        continue;
      } else {
        val = v.map(item => {
          if (
            item &&
            typeof item === "object" &&
            Object.prototype.hasOwnProperty.call(item, textNodeName)
          ) {
            const textVal = (item as Record<string, unknown>)[
              textNodeName as "#text"
            ];
            return typeof textVal === "string" ? textVal.trim() : textVal;
          }
          return typeof item === "string" ? item.trim() : item;
        });
      }
    } else if (
      v &&
      typeof v === "object" &&
      !Object.prototype.hasOwnProperty.call(v, textNodeName)
    ) {
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj);

      if (keys.length === 1 && keys[0] === "item") {
        const itemValue = obj.item as unknown;
        if (Array.isArray(itemValue)) {
          val = itemValue.map(item => {
            let currentVal: unknown = item;
            if (
              item &&
              typeof item === "object" &&
              Object.prototype.hasOwnProperty.call(item, textNodeName)
            ) {
              currentVal = (item as Record<string, unknown>)[
                textNodeName as "#text"
              ];
            }
            const trimmed =
              typeof currentVal === "string" ? currentVal.trim() : currentVal;
            if (
              typeof trimmed === "string" &&
              /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)
            ) {
              const num = Number(trimmed);
              if (Number.isFinite(num)) return num;
            }
            return trimmed;
          });
        } else {
          const trimmed =
            typeof itemValue === "string" ? itemValue.trim() : itemValue;
          if (
            typeof trimmed === "string" &&
            /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)
          ) {
            const num = Number(trimmed);
            val = Number.isFinite(num) ? num : trimmed;
          } else {
            val = trimmed;
          }
        }
      } else {
        let isIndexedTuple = false;
        if (keys.length > 0 && keys.every(key => /^\d+$/.test(key))) {
          const indices = keys.map(k => parseInt(k, 10)).sort((a, b) => a - b);
          isIndexedTuple =
            indices[0] === 0 && indices.every((val, idx) => val === idx);
        }

        if (isIndexedTuple) {
          const sortedKeys = keys.sort(
            (a, b) => parseInt(a, 10) - parseInt(b, 10)
          );
          val = sortedKeys.map(key => {
            const item = obj[key];
            if (
              item &&
              typeof item === "object" &&
              Object.prototype.hasOwnProperty.call(item, textNodeName)
            ) {
              const textVal = (item as Record<string, unknown>)[
                textNodeName as "#text"
              ];
              return typeof textVal === "string" ? textVal.trim() : textVal;
            }
            return typeof item === "string" ? item.trim() : item;
          });
        } else {
          val = v;
        }
      }
    }

    args[k] = typeof val === "string" ? val.trim() : val;
  }

  try {
    const coerced = coerceBySchema(args, schema) as Record<string, unknown>;
    return coerced;
  } catch (error) {
    throw new RXMLCoercionError("Failed to coerce by schema", error);
  }
}

export function stringify(
  rootTag: string,
  obj: unknown,
  options?: { format?: boolean; suppressEmptyNode?: boolean }
): string {
  try {
    const builder = new XMLBuilder({
      format: options?.format ?? true,
      suppressEmptyNode: options?.suppressEmptyNode ?? false,
    });
    return builder.build({ [rootTag]: obj });
  } catch (error) {
    throw new RXMLStringifyError("Failed to stringify XML", error);
  }
}
