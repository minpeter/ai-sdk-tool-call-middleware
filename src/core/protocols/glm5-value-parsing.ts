import { parse as parseRJSON } from "../../rjson";
import {
  coerceBySchema,
  getSchemaType,
  unwrapJsonSchema,
} from "../../schema-coerce";
import {
  hasPrototypeSensitiveStructuralKey,
  isPrototypeSensitiveArgumentKey,
} from "../utils/prototype-sensitive-keys";
import { toolCallInputHasSchemaAwarePrototypeSensitiveValue } from "../utils/tool-call-coercion";
import type { Glm5StringBoundaryNormalization } from "./glm5-call-types";

const LEADING_LAYOUT_RE = /^\r?\n[ \t]*/;
const TRAILING_LAYOUT_RE = /\r?\n[ \t]*$/;
const TRAILING_WHITESPACE_RE = /[ \t\r\n]+$/;
const BARE_CODE_REFERENCE_RE =
  /^[A-Za-z_$][\w$]*(?:(?:\.[A-Za-z_$][\w$]*)|(?:\[(?:\d+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\])|(?:\(\)))*$/;
const PROTOTYPE_REFERENCE_SEGMENT_RE =
  /(?:^|\.)(?:__proto__|constructor|prototype)(?=$|[.(])/;
const STRICT_JSON_OPTIONS = {
  duplicate: false,
  relaxed: false,
  tolerant: false,
} as const;

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

export function createGlm5Args(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
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

export function isIncrementallyStreamableGlm5StringSchema(
  schema: unknown
): boolean {
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

export function safeAssignGlm5Arg(
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

type ParsedGlm5Value =
  | { ok: true; recovery?: "recovered-opaque-object-reference"; value: unknown }
  | { ok: false };

function parseStructuredGlm5Value(
  value: string,
  propertySchema: unknown
): ParsedGlm5Value {
  try {
    const parsed = parseRJSON(value, STRICT_JSON_OPTIONS);
    const coerced = coerceBySchema(parsed, propertySchema);
    return toolCallInputHasSchemaAwarePrototypeSensitiveValue(
      coerced,
      propertySchema
    )
      ? { ok: false }
      : { ok: true, value: coerced };
  } catch {
    return { ok: false };
  }
}

export function parseCompletedGlm5Value(
  rawValue: string,
  propertySchema: unknown,
  normalization: Glm5StringBoundaryNormalization,
  recoverOpaqueObjectReferences: boolean
): ParsedGlm5Value {
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
    const parsed = parseStructuredGlm5Value(normalized.trim(), propertySchema);
    if (parsed.ok) {
      return parsed;
    }
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
  const trimmed = normalized.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return parseStructuredGlm5Value(trimmed, propertySchema);
  }
  const value = coerceBySchema(normalized, propertySchema);
  return toolCallInputHasSchemaAwarePrototypeSensitiveValue(
    value,
    propertySchema
  )
    ? { ok: false }
    : { ok: true, value };
}
