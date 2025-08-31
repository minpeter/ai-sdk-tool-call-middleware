import {
  LanguageModelV2Content,
  LanguageModelV2ToolCall,
  LanguageModelV2ToolResultPart,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";
import { XMLBuilder, XMLParser } from "fast-xml-parser";

import { escapeRegExp, hasInputProperty } from "@/utils";
import {
  coerceBySchema,
  getSchemaType,
  unwrapJsonSchema,
} from "@/utils/coercion";

import { ToolCallProtocol } from "./tool-call-protocol";

// Controls whether the parser emits warnings when duplicate string tags are detected
const WARN_ON_DUPLICATE_STRING_TAGS: boolean = true;

// Use shared schema type resolver from coercion utils

function getToolSchema(
  tools: Array<{ name?: string; inputSchema?: unknown }>,
  originalSchemas: Record<string, unknown>,
  toolName: string
): unknown {
  const original = originalSchemas[toolName];
  if (original) return original;
  const fallback = tools.find(t => t.name === toolName)?.inputSchema;
  return fallback as unknown;
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

function extractRawInner(
  xmlContent: string,
  tagName: string
): string | undefined {
  // Extract the raw inner content of the FIRST TOP-LEVEL occurrence of <tagName ...>...</tagName>
  // within xmlContent (which is expected to be the inside of the tool element).
  // This preserves raw markup and avoids accidentally matching nested same-named tags inside other fields.
  const len = xmlContent.length;
  const target = tagName;
  let bestStart = -1;
  let bestEnd = -1;
  let bestDepth = Number.POSITIVE_INFINITY;

  // Helper to advance over a quoted attribute value
  const skipQuoted = (s: string, i: number): number => {
    const quote = s[i];
    i++;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "\\") {
        i += 2; // skip escaped char
        continue;
      }
      if (ch === quote) {
        return i + 1;
      }
      i++;
    }
    return i;
  };

  // Scan for top-level start tag of the desired name
  let i = 0;
  let depth = 0;
  while (i < len) {
    const lt = xmlContent.indexOf("<", i);
    if (lt === -1) return undefined;

    // emit any text; move to tag
    i = lt + 1;
    if (i >= len) return undefined;

    const ch = xmlContent[i];
    // Skip comments, CDATA, declarations, and processing instructions
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
      // e.g., <!DOCTYPE ...>
      const gt = xmlContent.indexOf(">", i + 1);
      i = gt === -1 ? len : gt + 1;
      continue;
    } else if (ch === "?") {
      // processing instruction <? ... ?>
      const close = xmlContent.indexOf("?>", i + 1);
      i = close === -1 ? len : close + 2;
      continue;
    } else if (ch === "/") {
      // end tag
      // read name
      let j = i + 1;
      while (j < len && /[-A-Za-z0-9_:\\]/.test(xmlContent[j])) j++;
      // move to '>'
      const gt = xmlContent.indexOf(">", j);
      i = gt === -1 ? len : gt + 1;
      depth = Math.max(0, depth - 1);
      continue;
    } else {
      // start tag
      let j = i;
      while (j < len && /[-A-Za-z0-9_:\\]/.test(xmlContent[j])) j++;
      const name = xmlContent.slice(i, j);

      // skip attributes to '>' while respecting quotes
      let k = j;
      let isSelfClosing = false;
      while (k < len) {
        const c = xmlContent[k];
        if (c === '"' || c === "'") {
          k = skipQuoted(xmlContent, k);
          continue;
        }
        if (c === ">") {
          break;
        }
        if (c === "/" && xmlContent[k + 1] === ">") {
          isSelfClosing = true;
          k++;
          break;
        }
        k++;
      }
      const tagEnd = k; // points at '>' or at the second char of '/>'

      if (name === target) {
        const contentStart =
          xmlContent[tagEnd] === ">" ? tagEnd + 1 : tagEnd + 1;
        if (isSelfClosing) {
          if (depth < bestDepth) {
            bestStart = contentStart;
            bestEnd = contentStart; // empty content
            bestDepth = depth;
            if (bestDepth === 0) {
              // cannot get shallower than 0
              // continue scanning in case of errors, but we already have best
            }
          }
        } else {
          // Compute matching closing tag for this occurrence without affecting outer scan state
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
              // end tag
              let t = nx + 1;
              while (t < len && /[-A-Za-z0-9_:\\]/.test(xmlContent[t])) t++;
              const endName = xmlContent.slice(nx + 1, t);
              const gt2 = xmlContent.indexOf(">", t);
              if (endName === target) {
                sameDepth--;
                if (sameDepth === 0) {
                  if (depth < bestDepth) {
                    bestStart = contentStart;
                    bestEnd = nextLt;
                    bestDepth = depth;
                    if (bestDepth === 0) {
                      // minimal possible depth; we can stop searching deeper candidates
                    }
                  }
                  break;
                }
              }
              pos = gt2 === -1 ? len : gt2 + 1;
              continue;
            } else {
              // start tag
              let t = nx;
              while (t < len && /[-A-Za-z0-9_:\\]/.test(xmlContent[t])) t++;
              const startName = xmlContent.slice(nx, t);
              // skip attributes
              let u = t;
              let selfClose = false;
              while (u < len) {
                const cu = xmlContent[u];
                if (cu === '"' || cu === "'") {
                  u = skipQuoted(xmlContent, u);
                  continue;
                }
                if (cu === ">") break;
                if (cu === "/" && xmlContent[u + 1] === ">") {
                  selfClose = true;
                  u++;
                  break;
                }
                u++;
              }
              if (startName === target && !selfClose) {
                sameDepth++;
              }
              pos = xmlContent[u] === ">" ? u + 1 : u + 1;
              continue;
            }
          }
        }
      }

      // Advance and adjust depth accordingly
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

function findFirstTopLevelRange(
  xmlContent: string,
  tagName: string
): { start: number; end: number } | undefined {
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
      while (j < len && /[A-Za-z0-9_:\\-]/.test(xmlContent[j])) j++;
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
        // find matching close
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
            while (t < len && /[A-Za-z0-9_:\\-]/.test(xmlContent[t])) t++;
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
            while (t < len && /[A-Za-z0-9_:\\-]/.test(xmlContent[t])) t++;
            // skip attributes
            let u = t;
            let selfClose = false;
            while (u < len) {
              const cu = xmlContent[u];
              if (cu === '"' || cu === "'") {
                u = skipQuoted(xmlContent, u);
                continue;
              }
              if (cu === ">") break;
              if (cu === "/" && xmlContent[u + 1] === ">") {
                selfClose = true;
                u++;
                break;
              }
              u++;
            }
            if (!selfClose) {
              // nested tag
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

function countTagOccurrences(
  xmlContent: string,
  tagName: string,
  excludeRanges?: Array<{ start: number; end: number }>,
  skipFirst: boolean = true
): number {
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
      while (j < len && /[-A-Za-z0-9_:\\]/.test(xmlContent[j])) j++;
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
          // Skip the first occurrence only once
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

// Shared helper to process parsed XML arguments according to schema and heuristics
// exported for internal use (test)
export function processParsedArgs(
  parsedArgs: Record<string, unknown>,
  toolSchema: unknown,
  toolContent: string,
  toolName: string,
  options?: {
    onError?: (message: string, meta?: Record<string, unknown>) => void;
  }
): { args: Record<string, unknown>; cancelToolCall: boolean } {
  const args: Record<string, unknown> = {};
  let cancelToolCall = false;
  // Precompute set of string-typed property names from the schema
  const stringTypedProps: Set<string> = (() => {
    const set = new Set<string>();
    const unwrapped = unwrapJsonSchema(toolSchema);
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

  for (const k of Object.keys(parsedArgs || {})) {
    const v = parsedArgs[k];
    let val: unknown = v;

    // If schema says this property is a string, prefer raw inner content
    const propSchema = getPropertySchema(toolSchema, k);
    const propType = getSchemaType(propSchema);
    if (propType === "string" && !Array.isArray(v)) {
      // Build exclusion ranges for other string-typed properties so that
      // occurrences of <k> nested inside other string fields' raw content
      // don't count as duplicates.
      const excludeRanges: Array<{ start: number; end: number }> = [];
      for (const other of stringTypedProps) {
        if (other === k) continue;
        const range = findFirstTopLevelRange(toolContent, other);
        if (range) excludeRanges.push(range);
      }
      const occurrences = countTagOccurrences(
        toolContent,
        k,
        excludeRanges,
        true
      );
      if (occurrences > 0) {
        if (WARN_ON_DUPLICATE_STRING_TAGS) {
          options?.onError?.(
            `Duplicate string tags for <${k}> detected; cancelling tool call`,
            {
              toolName,
              toolCall: `<${toolName}>${toolContent}</${toolName}>`,
            }
          );
        }
        cancelToolCall = true;
        break;
      }
      const raw = extractRawInner(toolContent, k);
      if (typeof raw === "string") {
        args[k] = raw; // do not trim or coerce raw string
        continue;
      }
    }

    // Handle text content extraction
    if (
      v &&
      typeof v === "object" &&
      Object.prototype.hasOwnProperty.call(v, "#text")
    ) {
      val = (v as Record<string, unknown>)?.["#text"];
    }

    // Heuristic array parsing for multiple tags with same name
    if (Array.isArray(v)) {
      if (propType === "string") {
        const mapped = v.map(item => {
          if (
            item &&
            typeof item === "object" &&
            Object.prototype.hasOwnProperty.call(item, "#text")
          ) {
            const textVal = (item as Record<string, unknown>)?.["#text"];
            return typeof textVal === "string" ? textVal : String(textVal);
          }
          return typeof item === "string" ? item : String(item);
        });

        if (mapped.length > 1 && WARN_ON_DUPLICATE_STRING_TAGS) {
          options?.onError?.(
            `Duplicate string tags for <${k}> detected; cancelling tool call`,
            {
              toolName,
              toolCall: `<${toolName}>${toolContent}</${toolName}>`,
            }
          );
        }

        if (mapped.length > 1) {
          cancelToolCall = true;
          break;
        } else {
          args[k] = mapped[0] ?? "";
          continue;
        }
      } else {
        val = v.map(item => {
          if (
            item &&
            typeof item === "object" &&
            Object.prototype.hasOwnProperty.call(item, "#text")
          ) {
            const textVal = (item as Record<string, unknown>)?.["#text"];
            return typeof textVal === "string" ? textVal.trim() : textVal;
          }
          return typeof item === "string" ? item.trim() : item;
        });
      }
    }
    // Heuristic tuple/array parsing for various XML patterns
    else if (
      v &&
      typeof v === "object" &&
      !Object.prototype.hasOwnProperty.call(v, "#text")
    ) {
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj);

      // Check for 'item' key pattern (common XML array pattern)
      if (keys.length === 1 && keys[0] === "item") {
        const itemValue = obj.item as unknown;
        if (Array.isArray(itemValue)) {
          val = itemValue.map(item => {
            let currentVal: unknown = item;
            if (
              item &&
              typeof item === "object" &&
              Object.prototype.hasOwnProperty.call(item, "#text")
            ) {
              currentVal = (item as Record<string, unknown>)?.["#text"];
            }
            const trimmed =
              typeof currentVal === "string" ? currentVal.trim() : currentVal;
            // Try to convert to number if it looks like one
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
      }
      // Check if all keys are numeric indices (0, 1, 2, ...) and consecutive
      else {
        let isIndexedTuple = false;
        if (keys.length > 0 && keys.every(key => /^\d+$/.test(key))) {
          const indices = keys.map(k => parseInt(k, 10)).sort((a, b) => a - b);
          isIndexedTuple =
            indices[0] === 0 && indices.every((val, idx) => val === idx);
        }

        if (isIndexedTuple) {
          // Convert indexed object to array (tuple)
          const sortedKeys = keys.sort(
            (a, b) => parseInt(a, 10) - parseInt(b, 10)
          );
          val = sortedKeys.map(key => {
            const item = obj[key];
            if (
              item &&
              typeof item === "object" &&
              Object.prototype.hasOwnProperty.call(item, "#text")
            ) {
              const textVal = (item as Record<string, unknown>)?.["#text"];
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

  return { args, cancelToolCall };
}

export const morphXmlProtocol = (): ToolCallProtocol => ({
  formatTools({ tools, toolSystemPromptTemplate }) {
    const toolsForPrompt = (tools || []).map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: unwrapJsonSchema(tool.inputSchema),
    }));
    return toolSystemPromptTemplate(JSON.stringify(toolsForPrompt));
  },

  formatToolCall(toolCall: LanguageModelV2ToolCall): string {
    const builder = new XMLBuilder({ format: true, suppressEmptyNode: true });
    // Some providers pass JSON string; some runtime paths may provide an object
    let args: unknown = {};
    const inputValue = hasInputProperty(toolCall) ? toolCall.input : undefined;

    if (typeof inputValue === "string") {
      try {
        args = JSON.parse(inputValue);
      } catch {
        args = inputValue;
      }
    } else {
      args = inputValue;
    }
    const xmlContent = builder.build({
      [toolCall.toolName]: args,
    });
    return xmlContent;
  },

  formatToolResponse(toolResult: LanguageModelV2ToolResultPart): string {
    const builder = new XMLBuilder({ format: true });
    const xmlContent = builder.build({
      tool_response: {
        tool_name: toolResult.toolName,
        result: toolResult.output,
      },
    });
    return xmlContent;
  },

  parseGeneratedText({ text, tools, options }) {
    // Get original schemas from provider options if available
    const originalSchemas =
      (options as { originalToolSchemas?: Record<string, unknown> } | undefined)
        ?.originalToolSchemas || {};

    // Optional debug
    // Schema-based coercion: convert string primitives according to tool JSON schema types

    const toolNames = tools.map(t => t.name).filter(name => name != null);
    if (toolNames.length === 0) {
      return [{ type: "text", text }];
    }

    const toolNamesPattern = toolNames.map(n => escapeRegExp(n)).join("|");
    const toolCallRegex = new RegExp(
      String.raw`<(${toolNamesPattern})>([\s\S]*?)<\/\1>`,
      "g"
    );

    const processedElements: LanguageModelV2Content[] = [];
    let currentIndex = 0;
    let match;

    while ((match = toolCallRegex.exec(text)) !== null) {
      const startIndex = match.index;
      const toolName = match[1];
      const toolContent = match[2].trim();

      if (startIndex > currentIndex) {
        const textSegment = text.substring(currentIndex, startIndex);
        if (textSegment.trim()) {
          processedElements.push({ type: "text", text: textSegment });
        }
      }

      try {
        const parser = new XMLParser({
          ignoreAttributes: false,
          parseTagValue: false,
          ignoreDeclaration: true,
          textNodeName: "#text",
        });
        const parsedArgs =
          parser.parse(`<root>${toolContent}</root>`)?.root || {};

        // Determine tool schema and process args via shared helper
        const toolSchema = getToolSchema(tools, originalSchemas, toolName);
        const { args, cancelToolCall } = processParsedArgs(
          parsedArgs,
          toolSchema,
          toolContent,
          toolName,
          options
        );

        if (cancelToolCall) {
          const originalCallText = match[0];
          options?.onError?.(
            `Duplicate string tags detected; cancelling tool call`,
            { toolCall: originalCallText, toolName }
          );
          processedElements.push({ type: "text", text: originalCallText });
        } else {
          // Use original schema if available, fallback to transformed schema
          // INTERNAL: `originalToolSchemas` is used to propagate the provider's
          // untouched tool schemas for better coercion. Not part of public API.
          const coercedArgs = coerceBySchema(args, toolSchema) as Record<
            string,
            unknown
          >;

          processedElements.push({
            type: "tool-call",
            toolCallId: generateId(),
            toolName,
            input: JSON.stringify(coercedArgs),
          });
        }
      } catch (error) {
        const message = `Could not process XML tool call, keeping original text: ${match[0]}`;
        options?.onError?.(message, { toolCall: match[0], toolName, error });
        processedElements.push({ type: "text", text: match[0] });
      }

      currentIndex = startIndex + match[0].length;
    }

    if (currentIndex < text.length) {
      const remainingText = text.substring(currentIndex);
      if (remainingText.trim()) {
        processedElements.push({ type: "text", text: remainingText });
      }
    }

    return processedElements;
  },

  createStreamParser({ tools, options }) {
    // Get original schemas from options if available
    const originalSchemas =
      (options as { originalToolSchemas?: Record<string, unknown> } | undefined)
        ?.originalToolSchemas || {};
    const toolNames = tools.map(t => t.name).filter(name => name != null);
    let buffer = "";
    let currentToolCall: { name: string; content: string } | null = null;
    let currentTextId: string | null = null;

    const flushText = (
      controller: TransformStreamDefaultController,
      text?: string
    ) => {
      const content = text ?? buffer;
      if (content) {
        if (!currentTextId) {
          currentTextId = generateId();
          controller.enqueue({ type: "text-start", id: currentTextId });
        }
        controller.enqueue({
          type: "text-delta",
          id: currentTextId,
          delta: content,
        });
        // Only clear the internal buffer when we are flushing the buffer itself.
        // When flushing an explicit slice (textBeforeTag), keep buffer intact so
        // subsequent substring operations use the original indices.
        if (text === undefined) {
          buffer = "";
        }
      }

      if (currentTextId && !text) {
        controller.enqueue({ type: "text-end", id: currentTextId });
        currentTextId = null;
      }
    };

    return new TransformStream({
      transform(chunk, controller) {
        if (chunk.type !== "text-delta") {
          if (buffer) flushText(controller);
          controller.enqueue(chunk);
          return;
        }

        buffer += chunk.delta;

        while (true) {
          if (currentToolCall) {
            const endTag = `</${currentToolCall.name}>`;
            const endTagIndex = buffer.indexOf(endTag);

            if (endTagIndex !== -1) {
              const toolContent = buffer.substring(0, endTagIndex);
              buffer = buffer.substring(endTagIndex + endTag.length);

              try {
                const parser = new XMLParser({
                  ignoreAttributes: false,
                  parseTagValue: false,
                  ignoreDeclaration: true,
                  textNodeName: "#text",
                });
                const parsedArgs =
                  parser.parse(`<root>${toolContent}</root>`)?.root || {};

                const toolSchema = getToolSchema(
                  tools,
                  originalSchemas,
                  currentToolCall!.name
                );
                const { args, cancelToolCall } = processParsedArgs(
                  parsedArgs,
                  toolSchema,
                  toolContent,
                  currentToolCall!.name,
                  options
                );

                if (cancelToolCall) {
                  const originalCallText = `<${currentToolCall.name}>${toolContent}</${currentToolCall.name}>`;
                  if (options?.onError) {
                    options.onError(
                      "Duplicate string tags detected; cancelling tool call",
                      {
                        toolCall: originalCallText,
                        toolName: currentToolCall.name,
                      }
                    );
                  }
                  flushText(controller, originalCallText);
                } else {
                  // Use original schema if available, fallback to transformed schema
                  const coercedArgs = coerceBySchema(
                    args,
                    toolSchema
                  ) as Record<string, unknown>;

                  flushText(controller);
                  controller.enqueue({
                    type: "tool-call",
                    toolCallId: generateId(),
                    toolName: currentToolCall.name,
                    input: JSON.stringify(coercedArgs),
                  });
                }
              } catch {
                const originalCallText = `<${currentToolCall.name}>${toolContent}${endTag}`;
                if (options?.onError) {
                  options.onError(
                    "Could not process streaming XML tool call; emitting original text.",
                    {
                      toolCall: originalCallText,
                      toolName: currentToolCall.name,
                    }
                  );
                }
                flushText(controller, originalCallText);
              }
              currentToolCall = null;
            } else {
              break;
            }
          } else {
            let earliestStartTagIndex = -1;
            let earliestToolName = "";

            if (toolNames.length > 0) {
              for (const name of toolNames) {
                const startTag = `<${name}>`;
                const index = buffer.indexOf(startTag);
                if (
                  index !== -1 &&
                  (earliestStartTagIndex === -1 ||
                    index < earliestStartTagIndex)
                ) {
                  earliestStartTagIndex = index;
                  earliestToolName = name;
                }
              }
            }

            if (earliestStartTagIndex !== -1) {
              const textBeforeTag = buffer.substring(0, earliestStartTagIndex);
              flushText(controller, textBeforeTag);

              const startTag = `<${earliestToolName}>`;
              buffer = buffer.substring(
                earliestStartTagIndex + startTag.length
              );
              currentToolCall = { name: earliestToolName, content: "" };
            } else {
              break;
            }
          }
        }
      },
      flush(controller) {
        if (currentToolCall) {
          const unfinishedCall = `<${currentToolCall.name}>${buffer}`;
          flushText(controller, unfinishedCall);
        } else if (buffer) {
          flushText(controller);
        }

        if (currentTextId) {
          controller.enqueue({ type: "text-end", id: currentTextId });
        }
      },
    });
  },

  extractToolCallSegments({ text, tools }) {
    const toolNames = tools.map(t => t.name).filter(Boolean) as string[];
    if (toolNames.length === 0) return [];
    const names = toolNames.map(n => escapeRegExp(String(n))).join("|");
    if (!names) return [];
    const regex = new RegExp(`<(${names})>[\\s\\S]*?<\\/\\1>`, "g");
    const segments: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) != null) {
      segments.push(m[0]);
    }
    return segments;
  },
});
