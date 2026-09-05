import type { JSONObject, LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import {
  isSchemaDefinition,
  type ToolInputSchemaCandidate,
} from "../../schema/tool-input-schema";
import { schemaHasProperty } from "../../schema-coerce/schema-introspection";
import { isPrototypeSensitiveArgumentKey } from "../utils/prototype-sensitive-keys";
import { decodeStructuredTextEscapes } from "../utils/structured-text-escapes";
import { getToolInputPropertyNames } from "../utils/tool-call-object-schema";
import type {
  NameResolution,
  ResolvedGlm5ProtocolOptions,
} from "./glm5-call-types";

const WRAPPING_NAME_QUOTES_RE = /^(?:"([^"]+)"|'([^']+)'|`([^`]+)`)$/;
const GENERATED_TOOL_DIGEST_SUFFIX_RE = /_([0-9a-f]{12})(?:_\d+)?$/i;
const GENERATED_TOOL_MUTATED_DIGEST_RE = /^[0-9a-f]{1,32}(?:_\d+)?$/i;
const TRAILING_IDS_SUFFIX = "_ids";
const STRUCTURAL_NAME_SUFFIX_RE =
  /^<\s*\/?\s*(?:arg_key|arg_value|tool_call)\s*>/i;
const MAX_GLM5_RECOVERABLE_NAME_LENGTH = 4096;

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

export function isPrototypeSensitiveRawArgumentKey(value: string): boolean {
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

export function resolveArgumentName(options: {
  args: JSONObject;
  rawName: string;
  schema: ToolInputSchemaCandidate;
  recoverNames: boolean;
}): NameResolution | null {
  const rawValue = stripWrappingNameQuotes(options.rawName);
  if (!rawValue) {
    return null;
  }
  const schema = isSchemaDefinition(options.schema)
    ? options.schema
    : undefined;
  const declared = schema
    ? getToolInputPropertyNames(schema, options.args)
    : null;
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
