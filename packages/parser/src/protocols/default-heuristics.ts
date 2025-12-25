/**
 * Default heuristics for XML tool-call parsing.
 * Modular, reusable versions of normalization/repair logic from morph-xml-protocol.
 */

import { parse, unwrapJsonSchema } from "@ai-sdk-tool/rxml";
import type {
  HeuristicResult,
  IntermediateCall,
  PipelineConfig,
  ToolCallHeuristic,
} from "./heuristic-engine";

const MALFORMED_CLOSE_RE_G = /<\/\s+([A-Za-z0-9_:-]+)\s*>/g;
const MALFORMED_CLOSE_RE = /<\/\s+([A-Za-z0-9_:-]+)\s*>/;
const STATUS_TO_STEP_BOUNDARY_RE = /<\/status>\s*<step>/g;
const WHITESPACE_REGEX = /\s/;
const NAME_CHAR_RE = /[A-Za-z0-9_:-]/;
const STEP_TAG_RE = /<step>([\s\S]*?)<\/step>/i;
const STATUS_TAG_RE = /<status>([\s\S]*?)<\/status>/i;

export const normalizeCloseTagsHeuristic: ToolCallHeuristic = {
  id: "normalize-close-tags",
  phase: "pre-parse",
  applies: () => true,
  run: (ctx: IntermediateCall): HeuristicResult => {
    const normalized = ctx.rawSegment.replace(MALFORMED_CLOSE_RE_G, "</$1>");
    if (normalized !== ctx.rawSegment) {
      return { rawSegment: normalized };
    }
    return {};
  },
};

export const escapeInvalidLtHeuristic: ToolCallHeuristic = {
  id: "escape-invalid-lt",
  phase: "pre-parse",
  applies: () => true,
  run: (ctx: IntermediateCall): HeuristicResult => {
    const escaped = escapeInvalidLt(ctx.rawSegment);
    if (escaped !== ctx.rawSegment) {
      return { rawSegment: escaped };
    }
    return {};
  },
};

export const balanceTagsHeuristic: ToolCallHeuristic = {
  id: "balance-tags",
  phase: "fallback-reparse",
  applies: (ctx: IntermediateCall): boolean => {
    const original = (ctx.meta?.originalContent as string) || ctx.rawSegment;
    const normalized = original.replace(MALFORMED_CLOSE_RE_G, "</$1>");
    const balanced = balanceTags(original);
    const hasMalformedClose = MALFORMED_CLOSE_RE.test(original);

    if (!hasMalformedClose && balanced.length > normalized.length) {
      return false;
    }
    return balanced !== normalized;
  },
  run: (ctx: IntermediateCall): HeuristicResult => {
    const original = (ctx.meta?.originalContent as string) || ctx.rawSegment;
    const balanced = balanceTags(original);
    const escaped = escapeInvalidLt(balanced);
    return { rawSegment: escaped, reparse: true };
  },
};

export const dedupeShellStringTagsHeuristic: ToolCallHeuristic = {
  id: "dedupe-shell-string-tags",
  phase: "fallback-reparse",
  applies: (ctx: IntermediateCall): boolean =>
    shouldDeduplicateStringTags(ctx.schema),
  run: (ctx: IntermediateCall): HeuristicResult => {
    const names = getStringPropertyNames(ctx.schema);
    let deduped = ctx.rawSegment;
    for (const key of names) {
      deduped = dedupeSingleTag(deduped, key);
    }
    if (deduped !== ctx.rawSegment) {
      return { rawSegment: deduped, reparse: true };
    }
    return {};
  },
};

export const repairAgainstSchemaHeuristic: ToolCallHeuristic = {
  id: "repair-against-schema",
  phase: "post-parse",
  applies: (ctx: IntermediateCall): boolean =>
    ctx.parsed !== null && typeof ctx.parsed === "object",
  run: (ctx: IntermediateCall): HeuristicResult => {
    const repaired = repairParsedAgainstSchema(ctx.parsed, ctx.schema);
    if (repaired !== ctx.parsed) {
      return { parsed: repaired };
    }
    return {};
  },
};

export const defaultPipelineConfig: PipelineConfig = {
  preParse: [normalizeCloseTagsHeuristic, escapeInvalidLtHeuristic],
  fallbackReparse: [balanceTagsHeuristic, dedupeShellStringTagsHeuristic],
  postParse: [repairAgainstSchemaHeuristic],
};

function escapeInvalidLt(xml: string): string {
  const len = xml.length;
  let out = "";
  for (let i = 0; i < len; i += 1) {
    const ch = xml[i];
    if (ch === "<") {
      const next = i + 1 < len ? xml[i + 1] : "";
      if (
        !(
          NAME_CHAR_RE.test(next) ||
          next === "/" ||
          next === "!" ||
          next === "?"
        )
      ) {
        out += "&lt;";
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function balanceTags(xml: string): string {
  const src = xml
    .replace(MALFORMED_CLOSE_RE_G, "</$1>")
    .replace(STATUS_TO_STEP_BOUNDARY_RE, "</status></step><step>");
  let i = 0;
  const len = src.length;
  const out: string[] = [];
  const stack: string[] = [];

  while (i < len) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      out.push(src.slice(i));
      break;
    }
    out.push(src.slice(i, lt));
    if (lt + 1 >= len) {
      break;
    }
    const next = src[lt + 1];
    if (next === "!" || next === "?") {
      i = handleSpecialTagSegment(src, lt, out);
      continue;
    }
    if (next === "/") {
      i = handleClosingTagSegment(src, lt, out, stack);
      continue;
    }
    i = handleOpeningTagSegment(src, lt, out, stack);
  }

  for (let k = stack.length - 1; k >= 0; k -= 1) {
    out.push(`</${stack[k]}>`);
  }
  return out.join("");
}

function skipWs(s: string, p: number, len: number): number {
  let idx = p;
  while (idx < len && WHITESPACE_REGEX.test(s[idx])) {
    idx += 1;
  }
  return idx;
}

function parseTagNameAt(
  s: string,
  p: number,
  len: number
): { name: string; pos: number } {
  let idx = p;
  const start = idx;
  while (idx < len && NAME_CHAR_RE.test(s[idx])) {
    idx += 1;
  }
  return { name: s.slice(start, idx), pos: idx };
}

function handleSpecialTagSegment(
  src: string,
  lt: number,
  out: string[]
): number {
  const gt = src.indexOf(">", lt + 1);
  if (gt === -1) {
    out.push(src.slice(lt));
    return src.length;
  }
  out.push(src.slice(lt, gt + 1));
  return gt + 1;
}

function handleClosingTagSegment(
  src: string,
  lt: number,
  out: string[],
  stack: string[]
): number {
  const len = src.length;
  let p = skipWs(src, lt + 2, len);
  const { name, pos } = parseTagNameAt(src, p, len);
  p = pos;
  const gt = src.indexOf(">", p);
  const closingText = gt === -1 ? src.slice(lt) : src.slice(lt, gt + 1);
  const idx = stack.lastIndexOf(name);
  if (idx !== -1) {
    for (let k = stack.length - 1; k > idx; k -= 1) {
      out.push(`</${stack[k]}>`);
      stack.pop();
    }
    out.push(closingText);
    stack.pop();
  }
  return gt === -1 ? len : gt + 1;
}

function handleOpeningTagSegment(
  src: string,
  lt: number,
  out: string[],
  stack: string[]
): number {
  const len = src.length;
  let p = skipWs(src, lt + 1, len);
  const nameStart = p;
  const parsed = parseTagNameAt(src, p, len);
  p = parsed.pos;
  const name = src.slice(nameStart, p);
  const q = src.indexOf(">", p);
  if (q === -1) {
    out.push(src.slice(lt));
    return len;
  }
  let r = q - 1;
  while (r >= nameStart && WHITESPACE_REGEX.test(src[r])) {
    r -= 1;
  }
  const selfClosing = src[r] === "/";
  out.push(src.slice(lt, q + 1));
  if (!selfClosing && name) {
    stack.push(name);
  }
  return q + 1;
}

function shouldDeduplicateStringTags(schema: unknown): boolean {
  const unwrapped = unwrapJsonSchema(schema as unknown) as Record<
    string,
    unknown
  >;
  if (!unwrapped || typeof unwrapped !== "object") {
    return false;
  }
  const props = (unwrapped as { properties?: Record<string, unknown> })
    .properties as Record<string, unknown> | undefined;
  if (!props) {
    return false;
  }
  const commandRaw = (props as Record<string, unknown>).command as unknown;
  if (!commandRaw) {
    return false;
  }
  const command = unwrapJsonSchema(commandRaw) as { type?: string } | undefined;
  return command?.type === "array";
}

function getStringPropertyNames(schema: unknown): string[] {
  const unwrapped = unwrapJsonSchema(schema as unknown) as Record<
    string,
    unknown
  >;
  if (!unwrapped || typeof unwrapped !== "object") {
    return [];
  }
  const props = (unwrapped as { properties?: Record<string, unknown> })
    .properties;
  if (!props) {
    return [];
  }
  const names: string[] = [];
  for (const key of Object.keys(props)) {
    const prop = unwrapJsonSchema(
      (props as Record<string, unknown>)[key] as unknown
    ) as unknown;
    const type = (prop as { type?: string }).type;
    if (type === "string") {
      names.push(key);
    }
  }
  return names;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dedupeSingleTag(xml: string, key: string): string {
  const escaped = escapeRegExp(key);
  const re = new RegExp(`<${escaped}>([\\s\\S]*?)<\\/${escaped}>`, "g");
  const matches = Array.from(xml.matchAll(re));
  if (matches.length <= 1) {
    return xml;
  }
  const last = matches.at(-1);
  let result = "";
  let cursor = 0;
  for (const m of matches) {
    const idx = m.index ?? 0;
    result += xml.slice(cursor, idx);
    if (last && idx === (last.index ?? -1)) {
      result += m[0];
    }
    cursor = idx + m[0].length;
  }
  result += xml.slice(cursor);
  return result;
}

function repairParsedAgainstSchema(input: unknown, schema: unknown): unknown {
  if (!input || typeof input !== "object") {
    return input;
  }
  const unwrapped = unwrapJsonSchema(schema as unknown) as Record<
    string,
    unknown
  >;
  if (!unwrapped || typeof unwrapped !== "object") {
    return input;
  }
  const properties = (unwrapped as { properties?: Record<string, unknown> })
    .properties;
  if (!properties) {
    return input;
  }
  applySchemaProps(input as Record<string, unknown>, properties);
  return input;
}

function applySchemaProps(
  obj: Record<string, unknown>,
  properties: Record<string, unknown>
): void {
  for (const key of Object.keys(obj)) {
    const propSchema = (properties as Record<string, unknown>)[key];
    if (!propSchema) {
      continue;
    }
    const prop = unwrapJsonSchema(propSchema as unknown) as unknown;
    const propType = (prop as { type?: string }).type;
    if (propType === "array" && (prop as { items?: unknown }).items) {
      const itemSchemaRaw = (prop as { items?: unknown }).items;
      const itemSchema = unwrapJsonSchema(itemSchemaRaw) as unknown;
      obj[key] = coerceArrayItems(obj[key], itemSchema) as unknown;
      continue;
    }
    if (propType === "object") {
      const val = obj[key];
      if (val && typeof val === "object") {
        obj[key] = repairParsedAgainstSchema(val as unknown, prop) as unknown;
      }
    }
  }
}

function coerceArrayItems(
  val: unknown,
  itemSchema: unknown
): unknown[] | unknown {
  if (!Array.isArray(val)) {
    return val as unknown;
  }
  return (val as unknown[]).map((v) => coerceArrayItem(v, itemSchema));
}

function coerceArrayItem(v: unknown, itemSchema: unknown): unknown {
  const itemType = (itemSchema as { type?: string })?.type;
  if (typeof v === "string" && itemType === "object") {
    const parsed = tryParseStringToSchemaObject(v, itemSchema);
    if (parsed !== null) {
      return parsed as unknown;
    }
    const fallback = extractStepStatusFromString(
      v.replace(MALFORMED_CLOSE_RE_G, "</$1>")
    );
    if (fallback) {
      return fallback as unknown;
    }
    return v;
  }
  if (v && typeof v === "object" && itemType === "object") {
    return repairParsedAgainstSchema(v as unknown, itemSchema) as unknown;
  }
  return v;
}

function tryParseStringToSchemaObject(
  xml: string,
  itemSchema: unknown
): unknown | null {
  try {
    const normalized = xml.replace(MALFORMED_CLOSE_RE_G, "</$1>");
    const fixed = parse(normalized, itemSchema, { noChildNodes: [] });
    return typeof fixed === "string" ? null : (fixed as unknown);
  } catch {
    return null;
  }
}

function extractStepStatusFromString(
  normXml: string
): Record<string, string> | null {
  const stepMatch = normXml.match(STEP_TAG_RE);
  const statusMatch = normXml.match(STATUS_TAG_RE);
  if (stepMatch && statusMatch) {
    return { step: stepMatch[1], status: statusMatch[1] };
  }
  return null;
}

export {
  escapeInvalidLt,
  balanceTags,
  shouldDeduplicateStringTags,
  getStringPropertyNames,
  dedupeSingleTag,
  repairParsedAgainstSchema,
};
