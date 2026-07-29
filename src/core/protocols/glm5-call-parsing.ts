import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { parse as parseRJSON } from "../../rjson";
import {
  coerceBySchema,
  getSchemaType,
  unwrapJsonSchema,
} from "../../schema-coerce";
import { schemaHasProperty } from "../../schema-coerce/schema-introspection";
import {
  hasPrototypeSensitiveStructuralKey,
  isPrototypeSensitiveArgumentKey,
} from "../utils/prototype-sensitive-keys";
import { decodeStructuredTextEscapes } from "../utils/structured-text-escapes";
import { toolCallInputHasSchemaAwarePrototypeSensitiveValue } from "../utils/tool-call-coercion";
import {
  getToolInputPropertyNames,
  getToolInputPropertySchema,
} from "../utils/tool-call-object-schema";
import { stringifyToolInputWithSchema } from "../utils/tool-input-streaming";

export type Glm5StringBoundaryNormalization = "layout" | "preserve";

export interface Glm5ProtocolOptions {
  /** Recover a final call whose closing structural tag was truncated. */
  recoverIncompleteToolCalls?: boolean;
  /** Recover uniquely matching case/punctuation variants of declared names. */
  recoverNames?: boolean;
  /**
   * Preserve a bounded bare code reference for an explicitly open object
   * schema. This matches GLM's raw-string argument grammar for handles such as
   * `responseData` without evaluating or completing arbitrary expressions.
   */
  recoverOpaqueObjectReferences?: boolean;
  /** Remove only newline-based XML layout indentation from string values. */
  stringBoundaryNormalization?: Glm5StringBoundaryNormalization;
}

export interface ResolvedGlm5ProtocolOptions {
  recoverIncompleteToolCalls: boolean;
  recoverNames: boolean;
  recoverOpaqueObjectReferences: boolean;
  stringBoundaryNormalization: Glm5StringBoundaryNormalization;
}

export interface ParsedGlm5Call {
  args: Record<string, unknown>;
  rawToolName: string;
  recoveries: string[];
  toolName: string;
}

export interface Glm5CallSnapshot extends ParsedGlm5Call {
  hasPartialValue: boolean;
}

interface StructuralTag {
  closing: boolean;
  end: number;
  name: "arg_key" | "arg_value";
  start: number;
}

export interface NameResolution {
  recovered: boolean;
  value: string;
}

const ARG_TAG_RE = /<\s*(\/?)[ \t\r\n]*(arg_key|arg_value)[ \t\r\n]*>/gi;
const NESTED_TOOL_CALL_OPEN_RE = /<\s*tool_call\s*>/gi;
const NESTED_TOOL_CALL_CLOSE_RE = /<\s*\/\s*tool_call\s*>/gi;
const NESTED_TOOL_NAME_BOUNDARY_RE = /[\r\n]|<\s*arg_key\s*>/i;
const LINE_BREAK_RE = /[\r\n]/;
const LEADING_LAYOUT_RE = /^\r?\n[ \t]*/;
const TRAILING_LAYOUT_RE = /\r?\n[ \t]*$/;
const TRAILING_WHITESPACE_RE = /[ \t\r\n]+$/;
const WRAPPING_NAME_QUOTES_RE = /^(?:"([^"]+)"|'([^']+)'|`([^`]+)`)$/;
const GENERATED_TOOL_DIGEST_SUFFIX_RE = /_([0-9a-f]{12})(?:_\d+)?$/i;
const GENERATED_TOOL_MUTATED_DIGEST_RE = /^[0-9a-f]{1,32}(?:_\d+)?$/i;
const TRAILING_IDS_SUFFIX = "_ids";
const STRUCTURAL_NAME_SUFFIX_RE =
  /^<\s*\/?\s*(?:arg_key|arg_value|tool_call)\s*>/i;
const BARE_CODE_REFERENCE_RE =
  /^[A-Za-z_$][\w$]*(?:(?:\.[A-Za-z_$][\w$]*)|(?:\[(?:\d+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\])|(?:\(\)))*$/;
const PROTOTYPE_REFERENCE_SEGMENT_RE =
  /(?:^|\.)(?:__proto__|constructor|prototype)(?=$|[.(])/;
const POTENTIAL_VALUE_TAGS = [
  "</arg_value>",
  "<arg_key>",
  "</tool_call>",
] as const;
const MAX_GLM5_ARGUMENT_TAGS = 2048;
const MAX_GLM5_RECOVERABLE_NAME_LENGTH = 4096;
export const MAX_GLM5_CALL_BODY_LENGTH = 1_048_576;
const STRICT_JSON_OPTIONS = {
  duplicate: false,
  relaxed: false,
  tolerant: false,
} as const;

export function resolveGlm5ProtocolOptions(
  options?: Glm5ProtocolOptions
): ResolvedGlm5ProtocolOptions {
  return {
    recoverOpaqueObjectReferences:
      options?.recoverOpaqueObjectReferences !== false,
    recoverIncompleteToolCalls: options?.recoverIncompleteToolCalls !== false,
    recoverNames: options?.recoverNames !== false,
    stringBoundaryNormalization:
      options?.stringBoundaryNormalization ?? "layout",
  };
}

function isExplicitlyOpenObjectSchema(schema: unknown): boolean {
  const unwrapped = unwrapJsonSchema(schema);
  return (
    getSchemaType(unwrapped) === "object" &&
    typeof unwrapped === "object" &&
    unwrapped !== null &&
    !Array.isArray(unwrapped) &&
    (unwrapped as Record<string, unknown>).additionalProperties === true
  );
}

function isSafeBareObjectReference(value: string, schema: unknown): boolean {
  const candidate = value.trim();
  return (
    candidate.length > 0 &&
    candidate.length <= 512 &&
    isExplicitlyOpenObjectSchema(schema) &&
    BARE_CODE_REFERENCE_RE.test(candidate) &&
    !PROTOTYPE_REFERENCE_SEGMENT_RE.test(candidate) &&
    !toolCallInputHasSchemaAwarePrototypeSensitiveValue(candidate, schema)
  );
}

function createArgs(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function scanStructuralTags(text: string): StructuralTag[] | null {
  const tags: StructuralTag[] = [];
  ARG_TAG_RE.lastIndex = 0;
  let match = ARG_TAG_RE.exec(text);
  while (match) {
    const start = match.index;
    tags.push({
      closing: match[1] === "/",
      end: start + match[0].length,
      name: (match[2] ?? "arg_key").toLowerCase() as StructuralTag["name"],
      start,
    });
    if (tags.length > MAX_GLM5_ARGUMENT_TAGS) {
      ARG_TAG_RE.lastIndex = 0;
      return null;
    }
    match = ARG_TAG_RE.exec(text);
  }
  ARG_TAG_RE.lastIndex = 0;
  return tags;
}

export function hasExplicitlyClosedGlm5TaggedBody(body: string): boolean {
  if (body.length > MAX_GLM5_CALL_BODY_LENGTH) {
    return false;
  }
  const tags = scanStructuralTags(body);
  if (!(tags && tags.length > 0 && tags.length % 4 === 0)) {
    return false;
  }
  const [firstTag] = tags;
  if (!(firstTag && body.slice(0, firstTag.start).trim().length > 0)) {
    return false;
  }

  let consumedUntil = firstTag.start;
  for (let index = 0; index < tags.length; index += 4) {
    const [keyOpen, keyClose, valueOpen, valueClose] = tags.slice(
      index,
      index + 4
    );
    if (
      keyOpen?.name !== "arg_key" ||
      keyOpen.closing ||
      keyClose?.name !== "arg_key" ||
      !keyClose.closing ||
      valueOpen?.name !== "arg_value" ||
      valueOpen.closing ||
      valueClose?.name !== "arg_value" ||
      !valueClose.closing ||
      body.slice(consumedUntil, keyOpen.start).trim().length > 0 ||
      body.slice(keyOpen.end, keyClose.start).trim().length === 0 ||
      body.slice(keyClose.end, valueOpen.start).trim().length > 0
    ) {
      return false;
    }
    consumedUntil = valueClose.end;
  }
  return body.slice(consumedUntil).trim().length === 0;
}

function normalizedIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) {
      return false;
    }
  }
  return true;
}

function stripWrappingNameQuotes(value: string): string {
  const match = WRAPPING_NAME_QUOTES_RE.exec(value.trim());
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? value).trim();
}

function stripStructuralNameSuffix(value: string): string {
  const boundary = value.indexOf("<");
  if (boundary <= 0 || !STRUCTURAL_NAME_SUFFIX_RE.test(value.slice(boundary))) {
    return value;
  }
  return value.slice(0, boundary).trimEnd();
}

function generatedToolStem(value: string): string | null {
  const match = GENERATED_TOOL_DIGEST_SUFFIX_RE.exec(value);
  return match ? value.slice(0, match.index) : null;
}

function uniqueMutatedGeneratedDigestMatch(
  value: string,
  names: string[]
): { kind: "ambiguous" | "none" } | { kind: "unique"; value: string } {
  const matches = names.filter((candidate) => {
    const stem = generatedToolStem(candidate);
    if (stem === null || !value.startsWith(`${stem}_`)) {
      return false;
    }
    const returnedSuffix = value.slice(stem.length + 1);
    return (
      candidate !== value &&
      GENERATED_TOOL_MUTATED_DIGEST_RE.test(returnedSuffix)
    );
  });
  if (matches.length === 1 && matches[0]) {
    return { kind: "unique", value: matches[0] };
  }
  return { kind: matches.length > 1 ? "ambiguous" : "none" };
}

function uniqueIdentifierVariantMatch(
  value: string,
  names: string[]
): string | null {
  const caseMatches = names.filter(
    (candidate) => candidate.toLowerCase() === value.toLowerCase()
  );
  if (caseMatches.length === 1) {
    return caseMatches[0] ?? null;
  }

  if (!isAscii(value)) {
    return null;
  }

  const normalized = normalizedIdentifier(value);
  if (!normalized) {
    return null;
  }
  const normalizedMatches = names.filter(
    (candidate) =>
      isAscii(candidate) && normalizedIdentifier(candidate) === normalized
  );
  return normalizedMatches.length === 1 ? (normalizedMatches[0] ?? null) : null;
}

function uniquePluralizedTrailingIdsMatch(
  value: string,
  names: string[]
): string | null {
  const matches = names.filter((candidate) => {
    if (!candidate.endsWith(`s${TRAILING_IDS_SUFFIX}`)) {
      return false;
    }
    return `${candidate.slice(0, -TRAILING_IDS_SUFFIX.length)}es` === value;
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function isPrototypeSensitiveRawArgumentKey(value: string): boolean {
  return isPrototypeSensitiveArgumentKey(
    decodeStructuredTextEscapes(stripWrappingNameQuotes(value))
  );
}

function resolveUniqueName(
  rawValue: string,
  candidates: Iterable<string>,
  allowRecovery: boolean
): NameResolution | null {
  const value = stripWrappingNameQuotes(rawValue);
  const names = Array.from(candidates);
  if (names.includes(value)) {
    return { recovered: value !== rawValue, value };
  }
  if (!allowRecovery || value.length > MAX_GLM5_RECOVERABLE_NAME_LENGTH) {
    return null;
  }

  // Some provider-native GLM parsers accidentally retain the first argument
  // markup tag in the function name. A declared name immediately followed by
  // a GLM structural tag is still unambiguous; arbitrary prose suffixes are
  // never stripped.
  const structuralPrefix = stripStructuralNameSuffix(value);
  if (structuralPrefix !== value && names.includes(structuralPrefix)) {
    return { recovered: true, value: structuralPrefix };
  }

  const recoveryValue = structuralPrefix;

  const identifierVariantMatch = uniqueIdentifierVariantMatch(
    recoveryValue,
    names
  );
  if (identifierVariantMatch) {
    return { recovered: true, value: identifierVariantMatch };
  }

  const pluralizedTrailingIdsMatch = uniquePluralizedTrailingIdsMatch(
    recoveryValue,
    names
  );
  if (pluralizedTrailingIdsMatch) {
    return { recovered: true, value: pluralizedTrailingIdsMatch };
  }

  // A byte-identical generated stem is stronger evidence than a digest by
  // itself. GLM can mutate the bounded digest into another declared digest;
  // resolving the digest first would then select an unrelated tool. Multiple
  // candidates sharing the full stem are deliberately fail-closed.
  const mutatedDigestMatch = uniqueMutatedGeneratedDigestMatch(
    recoveryValue,
    names
  );
  if (mutatedDigestMatch.kind === "unique") {
    return { recovered: true, value: mutatedDigestMatch.value };
  }
  if (mutatedDigestMatch.kind === "ambiguous") {
    return null;
  }

  // OpenAI-compatible bridges commonly sanitize long or dotted tool names and
  // append a 12-hex digest. GLM can faithfully retain the digest while
  // shortening the stem, or omit only the digest. Both forms remain
  // collision-safe when exactly one declared tool proves the mapping.
  const duplicatedDigestTailMatches = names.filter((candidate) => {
    if (!GENERATED_TOOL_DIGEST_SUFFIX_RE.test(candidate)) {
      return false;
    }
    const suffix = recoveryValue.slice(candidate.length);
    return (
      recoveryValue.startsWith(candidate) &&
      suffix.length > 0 &&
      suffix.length <= 4 &&
      candidate.toLowerCase().endsWith(suffix.toLowerCase())
    );
  });
  if (
    duplicatedDigestTailMatches.length === 1 &&
    duplicatedDigestTailMatches[0]
  ) {
    return { recovered: true, value: duplicatedDigestTailMatches[0] };
  }

  const digest =
    GENERATED_TOOL_DIGEST_SUFFIX_RE.exec(recoveryValue)?.[1]?.toLowerCase();
  if (digest) {
    const digestMatches = names.filter(
      (candidate) =>
        GENERATED_TOOL_DIGEST_SUFFIX_RE.exec(candidate)?.[1]?.toLowerCase() ===
        digest
    );
    if (digestMatches.length === 1 && digestMatches[0]) {
      return { recovered: true, value: digestMatches[0] };
    }
  } else {
    const lowerValue = recoveryValue.toLowerCase();
    const stemMatches = names.filter(
      (candidate) =>
        candidate.replace(GENERATED_TOOL_DIGEST_SUFFIX_RE, "").toLowerCase() ===
          lowerValue && candidate !== recoveryValue
    );
    if (stemMatches.length === 1 && stemMatches[0]) {
      return { recovered: true, value: stemMatches[0] };
    }
  }
  return null;
}

export function resolveGlm5ToolName(
  rawName: string,
  tools: LanguageModelV4FunctionTool[],
  options: ResolvedGlm5ProtocolOptions
): NameResolution | null {
  if (tools.some((tool) => tool.name === rawName)) {
    return { recovered: false, value: rawName };
  }
  return resolveUniqueName(
    rawName,
    tools.map((tool) => tool.name),
    options.recoverNames
  );
}

function resolveToolName(
  rawName: string,
  tools: LanguageModelV4FunctionTool[],
  options: ResolvedGlm5ProtocolOptions
): NameResolution | null {
  return resolveGlm5ToolName(rawName, tools, options);
}

function hasNestedDeclaredToolCall(options: {
  body: string;
  protocolOptions: ResolvedGlm5ProtocolOptions;
  tools: LanguageModelV4FunctionTool[];
}): boolean {
  let cursor = 0;
  NESTED_TOOL_CALL_OPEN_RE.lastIndex = 0;
  NESTED_TOOL_CALL_CLOSE_RE.lastIndex = 0;
  while (cursor < options.body.length) {
    NESTED_TOOL_CALL_OPEN_RE.lastIndex = cursor;
    const open = NESTED_TOOL_CALL_OPEN_RE.exec(options.body);
    if (!open) {
      break;
    }
    const openEnd = open.index + open[0].length;
    NESTED_TOOL_CALL_CLOSE_RE.lastIndex = openEnd;
    const close = NESTED_TOOL_CALL_CLOSE_RE.exec(options.body);
    if (!close) {
      break;
    }
    const innerBody = options.body.slice(openEnd, close.index);
    const boundary = innerBody.search(NESTED_TOOL_NAME_BOUNDARY_RE);
    const rawName = innerBody
      .slice(0, boundary < 0 ? innerBody.length : boundary)
      .trim();
    if (
      rawName &&
      resolveToolName(rawName, options.tools, options.protocolOptions)
    ) {
      NESTED_TOOL_CALL_OPEN_RE.lastIndex = 0;
      NESTED_TOOL_CALL_CLOSE_RE.lastIndex = 0;
      return true;
    }
    cursor = close.index + close[0].length;
  }
  NESTED_TOOL_CALL_OPEN_RE.lastIndex = 0;
  NESTED_TOOL_CALL_CLOSE_RE.lastIndex = 0;
  return false;
}

function resolveArgumentName(options: {
  args: Record<string, unknown>;
  rawName: string;
  schema: unknown;
  recoverNames: boolean;
}): NameResolution | null {
  const rawValue = stripWrappingNameQuotes(options.rawName);
  if (!rawValue) {
    return null;
  }
  const declared = getToolInputPropertyNames(options.schema, options.args);
  if (!declared || declared.size === 0) {
    return schemaHasProperty(options.schema, rawValue)
      ? { recovered: rawValue !== options.rawName, value: rawValue }
      : null;
  }
  const resolved = resolveUniqueName(
    options.rawName,
    declared,
    options.recoverNames
  );
  if (resolved) {
    return resolved;
  }
  return schemaHasProperty(options.schema, rawValue)
    ? { recovered: rawValue !== options.rawName, value: rawValue }
    : null;
}

function findTag(
  tags: StructuralTag[],
  from: number,
  name: StructuralTag["name"],
  closing: boolean
): number {
  for (let index = from; index < tags.length; index += 1) {
    const tag = tags[index];
    if (tag?.name === name && tag.closing === closing) {
      return index;
    }
  }
  return -1;
}

function findStructuralValueClose(
  body: string,
  tags: StructuralTag[],
  from: number
): number {
  for (let index = from; index < tags.length; index += 1) {
    const tag = tags[index];
    if (!(tag?.name === "arg_value" && tag.closing)) {
      continue;
    }
    const next = tags[index + 1];
    const gap = body.slice(tag.end, next?.start ?? body.length);
    if (gap.trim().length > 0) {
      continue;
    }
    if (!next || (next.name === "arg_key" && !next.closing)) {
      return index;
    }
  }
  return -1;
}

function partialTagOverlap(value: string): number {
  const lower = value.toLowerCase();
  let best = 0;
  for (const tag of POTENTIAL_VALUE_TAGS) {
    const max = Math.min(lower.length, tag.length - 1);
    for (let length = max; length > best; length -= 1) {
      if (lower.endsWith(tag.slice(0, length))) {
        best = length;
        break;
      }
    }
  }
  return best;
}

function removeTrailingHighSurrogate(value: string): string {
  const last = value.charCodeAt(value.length - 1);
  return last >= 0xd8_00 && last <= 0xdb_ff ? value.slice(0, -1) : value;
}

export function normalizeGlm5StringValue(options: {
  complete: boolean;
  mode: Glm5StringBoundaryNormalization;
  value: string;
}): string {
  const { complete, mode } = options;
  let { value } = options;
  if (mode === "layout") {
    value = value.replace(LEADING_LAYOUT_RE, "");
    value = complete
      ? value.replace(TRAILING_LAYOUT_RE, "")
      : value.replace(TRAILING_WHITESPACE_RE, "");
  }
  return complete ? value : removeTrailingHighSurrogate(value);
}

function isIncrementallyStreamableStringSchema(schema: unknown): boolean {
  if (getSchemaType(schema) !== "string") {
    return false;
  }
  const unwrapped = unwrapJsonSchema(schema);
  if (!unwrapped || typeof unwrapped !== "object" || Array.isArray(unwrapped)) {
    return true;
  }
  const record = unwrapped as Record<string, unknown>;
  return !(Object.hasOwn(record, "const") || Array.isArray(record.enum));
}

function safeAssignArg(
  args: Record<string, unknown>,
  key: string,
  value: unknown,
  recoveries: string[]
): boolean {
  if (isPrototypeSensitiveArgumentKey(key)) {
    recoveries.push("rejected-prototype-sensitive-key");
    return false;
  }
  if (Object.hasOwn(args, key)) {
    recoveries.push("rejected-duplicate-key");
    return false;
  }
  if (hasPrototypeSensitiveStructuralKey(value)) {
    recoveries.push("rejected-prototype-sensitive-value");
    return false;
  }
  args[key] = value;
  return true;
}

function parseJsonFallback(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    return null;
  }
  try {
    const parsed = parseRJSON(trimmed, STRICT_JSON_OPTIONS);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      hasPrototypeSensitiveStructuralKey(parsed)
    ) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseJsonCallBody(options: {
  body: string;
  protocolOptions: ResolvedGlm5ProtocolOptions;
  tools: LanguageModelV4FunctionTool[];
}): Glm5CallSnapshot | null {
  const parsed = parseJsonFallback(options.body);
  if (!parsed) {
    return null;
  }
  const rawName = parsed.name ?? parsed.toolName;
  if (typeof rawName !== "string") {
    return null;
  }
  const resolvedName = resolveToolName(
    rawName,
    options.tools,
    options.protocolOptions
  );
  if (!resolvedName) {
    return null;
  }
  const rawArgs = parsed.arguments ?? parsed.input ?? {};
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return null;
  }
  const schema = options.tools.find(
    (tool) => tool.name === resolvedName.value
  )?.inputSchema;
  if (toolCallInputHasSchemaAwarePrototypeSensitiveValue(rawArgs, schema)) {
    return null;
  }
  return {
    args: rawArgs as Record<string, unknown>,
    hasPartialValue: false,
    rawToolName: rawName,
    recoveries: [
      "recovered-json-call-body",
      ...(resolvedName.recovered ? ["recovered-tool-name"] : []),
    ],
    toolName: resolvedName.value,
  };
}

function extractRawToolName(options: {
  body: string;
  complete: boolean;
  tags: StructuralTag[];
}): { argsStart: number; rawName: string } | null {
  const firstTagStart = options.tags[0]?.start ?? -1;
  const newline = options.body.search(LINE_BREAK_RE);
  const boundaries = [firstTagStart, newline].filter((index) => index >= 0);
  if (boundaries.length === 0 && !options.complete) {
    return null;
  }
  const argsStart =
    boundaries.length > 0 ? Math.min(...boundaries) : options.body.length;
  const rawName = options.body.slice(0, argsStart).trim();
  return rawName ? { argsStart, rawName } : null;
}

function appendJsonFallbackArgs(options: {
  args: Record<string, unknown>;
  body: string;
  from: number;
  recoveries: string[];
  schema: unknown;
}): "appended" | "none" | "rejected" {
  const parsed = parseJsonFallback(options.body.slice(options.from));
  if (!parsed) {
    return "none";
  }
  for (const [key, value] of Object.entries(parsed)) {
    const propertySchema = getToolInputPropertySchema(
      options.schema,
      key,
      options.args
    );
    if (
      toolCallInputHasSchemaAwarePrototypeSensitiveValue(value, propertySchema)
    ) {
      return "rejected";
    }
    if (!safeAssignArg(options.args, key, value, options.recoveries)) {
      return "rejected";
    }
  }
  options.recoveries.push("recovered-json-arguments-body");
  return "appended";
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: schema-directed primitives, structured JSON, and one bounded opaque-reference recovery share the same security checks.
function parseCompletedGlm5Value(
  rawValue: string,
  propertySchema: unknown,
  normalization: Glm5StringBoundaryNormalization,
  recoverOpaqueObjectReferences: boolean
):
  | { ok: true; recovery?: "recovered-opaque-object-reference"; value: unknown }
  | { ok: false } {
  const normalized = normalizeGlm5StringValue({
    complete: true,
    mode: normalization,
    value: rawValue,
  });
  const schemaType = getSchemaType(propertySchema);
  if (schemaType === "string") {
    const value = coerceBySchema(normalized, propertySchema);
    return toolCallInputHasSchemaAwarePrototypeSensitiveValue(
      value,
      propertySchema
    )
      ? { ok: false }
      : { ok: true, value };
  }
  if (
    schemaType === "array" ||
    schemaType === "boolean" ||
    schemaType === "integer" ||
    schemaType === "null" ||
    schemaType === "number" ||
    schemaType === "object"
  ) {
    try {
      const parsed = parseRJSON(normalized.trim(), STRICT_JSON_OPTIONS);
      const value = coerceBySchema(parsed, propertySchema);
      return toolCallInputHasSchemaAwarePrototypeSensitiveValue(
        value,
        propertySchema
      )
        ? { ok: false }
        : { ok: true, value };
    } catch {
      if (
        schemaType === "object" &&
        recoverOpaqueObjectReferences &&
        isSafeBareObjectReference(normalized, propertySchema)
      ) {
        return {
          ok: true,
          recovery: "recovered-opaque-object-reference",
          value: normalized.trim(),
        };
      }
      return { ok: false };
    }
  }
  const trimmed = normalized.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed = parseRJSON(trimmed, STRICT_JSON_OPTIONS);
      const value = coerceBySchema(parsed, propertySchema);
      return toolCallInputHasSchemaAwarePrototypeSensitiveValue(
        value,
        propertySchema
      )
        ? { ok: false }
        : { ok: true, value };
    } catch {
      return { ok: false };
    }
  }
  const value = coerceBySchema(normalized, propertySchema);
  return toolCallInputHasSchemaAwarePrototypeSensitiveValue(
    value,
    propertySchema
  )
    ? { ok: false }
    : { ok: true, value };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: tolerant GLM markup scanning has several recovery boundaries.
export function parseGlm5CallBody(options: {
  body: string;
  complete: boolean;
  protocolOptions: ResolvedGlm5ProtocolOptions;
  tools: LanguageModelV4FunctionTool[];
}): Glm5CallSnapshot | null {
  if (options.body.length > MAX_GLM5_CALL_BODY_LENGTH) {
    return null;
  }
  if (hasNestedDeclaredToolCall(options)) {
    return null;
  }
  if (options.complete) {
    const jsonCall = parseJsonCallBody(options);
    if (jsonCall) {
      return jsonCall;
    }
  }

  const tags = scanStructuralTags(options.body);
  if (!tags) {
    return null;
  }
  const extractedName = extractRawToolName({
    body: options.body,
    complete: options.complete,
    tags,
  });
  if (!extractedName) {
    return null;
  }
  const resolvedName = resolveToolName(
    extractedName.rawName,
    options.tools,
    options.protocolOptions
  );
  if (!resolvedName) {
    return null;
  }

  const tool = options.tools.find(
    (candidate) => candidate.name === resolvedName.value
  );
  const schema = tool?.inputSchema;
  const args = createArgs();
  const recoveries = resolvedName.recovered ? ["recovered-tool-name"] : [];
  let hasPartialValue = false;
  let tagCursor = 0;
  let consumedUntil = extractedName.argsStart;

  while (tagCursor < tags.length) {
    const keyOpenIndex = findTag(tags, tagCursor, "arg_key", false);
    if (keyOpenIndex === -1) {
      break;
    }
    const keyOpen = tags[keyOpenIndex];
    if (!keyOpen) {
      break;
    }
    const keyCloseIndex = findTag(tags, keyOpenIndex + 1, "arg_key", true);
    const valueOpenIndex = findTag(tags, keyOpenIndex + 1, "arg_value", false);
    if (valueOpenIndex === -1) {
      break;
    }
    const valueOpen = tags[valueOpenIndex];
    if (!valueOpen) {
      break;
    }

    const keyClose = keyCloseIndex >= 0 ? tags[keyCloseIndex] : undefined;
    const keyEnd =
      keyClose && keyClose.start < valueOpen.start
        ? keyClose.start
        : valueOpen.start;
    if (!(keyClose && keyClose.start < valueOpen.start)) {
      recoveries.push("recovered-missing-arg-key-close");
    }
    const rawKey = options.body.slice(keyOpen.end, keyEnd).trim();
    // Prototype-sensitive keys are never merely "unknown". Reject the whole
    // call before schema-name resolution so a closed schema cannot turn an
    // unsafe argument into a seemingly valid zero-argument call.
    if (isPrototypeSensitiveRawArgumentKey(rawKey)) {
      return null;
    }
    const resolvedKey = resolveArgumentName({
      args,
      rawName: rawKey,
      recoverNames: options.protocolOptions.recoverNames,
      schema,
    });

    const valueCloseIndex = findStructuralValueClose(
      options.body,
      tags,
      valueOpenIndex + 1
    );
    const valueClose = valueCloseIndex >= 0 ? tags[valueCloseIndex] : undefined;

    let rawValue: string;
    let valueIsComplete: boolean;
    if (valueClose) {
      rawValue = options.body.slice(valueOpen.end, valueClose.start);
      valueIsComplete = true;
      tagCursor = valueCloseIndex + 1;
      consumedUntil = valueClose.end;
    } else {
      rawValue = options.body.slice(valueOpen.end);
      valueIsComplete = options.complete;
      tagCursor = tags.length;
      consumedUntil = options.body.length;
      if (options.complete) {
        recoveries.push("recovered-missing-arg-value-close");
      } else {
        const overlap = partialTagOverlap(rawValue);
        if (overlap > 0) {
          rawValue = rawValue.slice(0, -overlap);
        }
        hasPartialValue = true;
      }
    }

    if (!resolvedKey) {
      recoveries.push("dropped-unknown-argument-key");
      continue;
    }
    if (resolvedKey.recovered) {
      recoveries.push("recovered-argument-key");
    }
    const propertySchema = getToolInputPropertySchema(
      schema,
      resolvedKey.value,
      args
    );
    if (
      !(
        valueIsComplete || isIncrementallyStreamableStringSchema(propertySchema)
      )
    ) {
      continue;
    }
    let value: unknown;
    if (valueIsComplete) {
      const parsedValue = parseCompletedGlm5Value(
        rawValue,
        propertySchema,
        options.protocolOptions.stringBoundaryNormalization,
        options.protocolOptions.recoverOpaqueObjectReferences
      );
      if (!parsedValue.ok) {
        return null;
      }
      if (parsedValue.recovery) {
        recoveries.push(parsedValue.recovery);
      }
      ({ value } = parsedValue);
    } else {
      value = normalizeGlm5StringValue({
        complete: false,
        mode: options.protocolOptions.stringBoundaryNormalization,
        value: rawValue,
      });
      if (
        toolCallInputHasSchemaAwarePrototypeSensitiveValue(
          value,
          propertySchema
        )
      ) {
        continue;
      }
    }
    if (!safeAssignArg(args, resolvedKey.value, value, recoveries)) {
      return null;
    }
  }

  const [onlyTag] = tags;
  const declaredArgumentNames = getToolInputPropertyNames(schema, args);
  if (
    options.complete &&
    tags.length === 1 &&
    onlyTag?.name === "arg_value" &&
    onlyTag.closing &&
    declaredArgumentNames?.size === 0 &&
    options.body.slice(extractedName.argsStart, onlyTag.start).trim().length ===
      0 &&
    options.body.slice(onlyTag.end).trim().length === 0
  ) {
    consumedUntil = options.body.length;
    recoveries.push("recovered-stray-empty-arg-value-close");
  }

  if (tags.length === 0 && options.complete) {
    const fallbackResult = appendJsonFallbackArgs({
      args,
      body: options.body,
      from: extractedName.argsStart,
      recoveries,
      schema,
    });
    if (fallbackResult === "rejected") {
      return null;
    }
    if (
      fallbackResult === "none" &&
      options.body.slice(extractedName.argsStart).trim().length > 0
    ) {
      return null;
    }
    consumedUntil = options.body.length;
  }

  if (options.complete && options.body.slice(consumedUntil).trim().length > 0) {
    return null;
  }

  return {
    args,
    hasPartialValue,
    rawToolName: extractedName.rawName,
    recoveries: Array.from(new Set(recoveries)),
    toolName: resolvedName.value,
  };
}

export function stringifyGlm5CallInput(
  call: Pick<ParsedGlm5Call, "args" | "toolName">,
  tools: LanguageModelV4FunctionTool[]
): string {
  return stringifyToolInputWithSchema({
    args: call.args,
    toolName: call.toolName,
    tools,
  });
}
