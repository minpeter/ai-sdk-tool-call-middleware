import {
  isJSONObject,
  type JSONObject,
  type JSONValue,
} from "@ai-sdk/provider";
import YAML from "yaml";

const LEADING_WHITESPACE_RE = /^(\s*)/;
const INCOMPLETE_MAPPING_TAIL_RE = /^[^:[\]{}-][^:]*:\s*$/;
const INCOMPLETE_SEQUENCE_TAIL_RE = /^-\s*$/;
const BLOCK_SCALAR_KEY_RE = /:\s*[|>][-+0-9]*\s*$/;
const PLAIN_MAPPING_VALUE_RE = /^[^:[\]{}-][^:]*:\s*(.+)$/;
const PLAIN_SEQUENCE_VALUE_RE = /^-\s+(.+)$/;

interface LastMeaningfulLineInfo {
  indent: number;
  index: number;
  raw: string;
  trimmed: string;
}

export function normalizeYamlContent(yamlContent: string): {
  normalized: string;
  nonEmptyLines: string[];
} {
  let normalized = yamlContent;
  if (normalized.startsWith("\n")) {
    normalized = normalized.slice(1);
  }

  const lines = normalized.split("\n");
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  if (nonEmptyLines.length === 0) {
    return { normalized: "", nonEmptyLines };
  }

  const minIndent = Math.min(
    ...nonEmptyLines.map((line) => {
      const match = line.match(LEADING_WHITESPACE_RE);
      return match ? match[1].length : 0;
    })
  );
  if (minIndent > 0) {
    normalized = lines.map((line) => line.slice(minIndent)).join("\n");
  }

  return { normalized, nonEmptyLines };
}

export function parseYamlDocumentAsMapping(normalized: string): {
  value: JSONObject | null;
  errors: string[];
} {
  try {
    const doc = YAML.parseDocument(normalized);
    const errors = doc.errors.map((e: { message: string }) => e.message);
    const result = doc.toJSON();

    if (result === null) {
      return { value: {}, errors };
    }
    if (!isJSONObject(result)) {
      return { value: null, errors };
    }
    return { value: result, errors };
  } catch (error) {
    return {
      value: null,
      errors: [
        error instanceof Error ? error.message : "Unknown YAML parsing error",
      ],
    };
  }
}

function getLastMeaningfulLineInfo(
  input: string
): LastMeaningfulLineInfo | null {
  const lines = input.split("\n");
  let index = lines.length - 1;
  while (index >= 0) {
    const raw = lines[index] ?? "";
    const trimmed = raw.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("#")) {
      return {
        index,
        raw,
        trimmed,
        indent: raw.length - raw.trimStart().length,
      };
    }
    index -= 1;
  }
  return null;
}

function dropLastMeaningfulLine(input: string): string | null {
  const lineInfo = getLastMeaningfulLineInfo(input);
  if (!lineInfo) {
    return null;
  }

  return input.split("\n").slice(0, lineInfo.index).join("\n").trimEnd();
}

function hasIncompleteMappingTail(normalized: string): boolean {
  const lineInfo = getLastMeaningfulLineInfo(normalized);
  if (!lineInfo) {
    return false;
  }
  return INCOMPLETE_MAPPING_TAIL_RE.test(lineInfo.trimmed);
}

function hasIncompleteSequenceTail(normalized: string): boolean {
  const lineInfo = getLastMeaningfulLineInfo(normalized);
  if (!lineInfo) {
    return false;
  }
  return INCOMPLETE_SEQUENCE_TAIL_RE.test(lineInfo.trimmed);
}

function hasSplitNestedKeyTail(normalized: string): boolean {
  const lineInfo = getLastMeaningfulLineInfo(normalized);
  if (!lineInfo) {
    return false;
  }

  const { trimmed, indent, index } = lineInfo;
  if (indent === 0) {
    return false;
  }
  if (
    trimmed.startsWith("#") ||
    trimmed.startsWith("-") ||
    trimmed.includes(":")
  ) {
    return false;
  }

  const lines = normalized.split("\n");
  let parentIndex = index - 1;
  while (parentIndex >= 0) {
    const parentRaw = lines[parentIndex] ?? "";
    const parentTrimmed = parentRaw.trim();
    if (parentTrimmed.length === 0 || parentTrimmed.startsWith("#")) {
      parentIndex -= 1;
      continue;
    }

    const parentIndent = parentRaw.length - parentRaw.trimStart().length;
    if (parentIndent >= indent) {
      parentIndex -= 1;
      continue;
    }

    if (!parentTrimmed.endsWith(":")) {
      return false;
    }
    if (BLOCK_SCALAR_KEY_RE.test(parentTrimmed)) {
      return false;
    }
    return true;
  }

  return false;
}

function extractTrailingPlainScalarValue(line: string): string | null {
  if (BLOCK_SCALAR_KEY_RE.test(line)) {
    return null;
  }

  const mappingMatch = line.match(PLAIN_MAPPING_VALUE_RE);
  const sequenceMatch = line.match(PLAIN_SEQUENCE_VALUE_RE);
  const value = mappingMatch?.[1] ?? sequenceMatch?.[1];
  if (!value) {
    return null;
  }

  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return null;
  }
  if (trimmedValue.startsWith('"') || trimmedValue.startsWith("'")) {
    return null;
  }
  if (
    trimmedValue.startsWith("{") ||
    trimmedValue.startsWith("[") ||
    trimmedValue.startsWith("|") ||
    trimmedValue.startsWith(">")
  ) {
    return null;
  }

  return trimmedValue;
}

function hasUnterminatedPlainScalarTail(normalized: string): boolean {
  if (normalized.endsWith("\n")) {
    return false;
  }

  const lineInfo = getLastMeaningfulLineInfo(normalized);
  if (!lineInfo) {
    return false;
  }

  return extractTrailingPlainScalarValue(lineInfo.trimmed) != null;
}

function hasUnstableProgressTail(normalized: string): boolean {
  return (
    hasIncompleteMappingTail(normalized) ||
    hasIncompleteSequenceTail(normalized) ||
    hasSplitNestedKeyTail(normalized) ||
    hasUnterminatedPlainScalarTail(normalized)
  );
}

function trimTrailingNewlineInJson(value: JSONValue): JSONValue {
  if (typeof value === "string") {
    return value.endsWith("\n") ? value.slice(0, -1) : value;
  }
  if (Array.isArray(value)) {
    return value.map(trimTrailingNewlineInJson);
  }
  if (isJSONObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        item === undefined ? undefined : trimTrailingNewlineInJson(item),
      ])
    );
  }
  return value;
}

function stabilizeParsedValueForStreamProgress(
  value: JSONValue,
  source: string
): JSONValue {
  if (source.endsWith("\n")) {
    return value;
  }

  return trimTrailingNewlineInJson(value);
}

export function parseYamlContentForStreamProgress(
  yamlContent: string
): JSONObject | null {
  const { normalized, nonEmptyLines } = normalizeYamlContent(yamlContent);
  if (nonEmptyLines.length === 0) {
    return {};
  }

  let candidate = normalized;
  while (true) {
    const parsed = parseYamlDocumentAsMapping(candidate);
    if (parsed.errors.length === 0 && !hasUnstableProgressTail(candidate)) {
      if (candidate.trim().length === 0 && normalized.trim().length > 0) {
        return null;
      }
      const stabilized = stabilizeParsedValueForStreamProgress(
        parsed.value,
        candidate
      );
      return isJSONObject(stabilized) ? stabilized : null;
    }

    const truncated = dropLastMeaningfulLine(candidate);
    if (truncated == null) {
      return null;
    }
    if (truncated === candidate) {
      return null;
    }
    candidate = truncated;
  }
}
