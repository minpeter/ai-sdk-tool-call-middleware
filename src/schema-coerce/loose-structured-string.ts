import { parse as parseRJSON } from "../rjson";
import { unescapeXml } from "../rxml/utils/helpers";

const COERCE_PROTOTYPE_SENSITIVE_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
/** Python literals models leak into JSON-ish payloads (`True`, `None`). */
const IDENTIFIER_CHAR_REGEX = /[\w$]/;
const XML_CHILD_VALUE_CLOSED_RE = /^<([A-Za-z_][\w.-]*)\s*>([^<]*)<\/\1\s*>$/;
const XML_CHILD_VALUE_OPEN_RE = /^<([A-Za-z_][\w.-]*)\s*>([^<]*\S[^<]*)$/;

const PYTHON_LITERAL_REPLACEMENTS: Record<string, string> = {
  True: "true",
  False: "false",
  None: "null",
};

/**
 * Replace bare Python literals (`True`/`False`/`None`) with their JSON
 * equivalents, quote-aware so occurrences inside string values (e.g.
 * `{'note': 'True story'}`) are never touched.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Quote-aware token replacement requires explicit string-state transitions.
function normalizePythonLiterals(s: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let out: string[] | null = null;
  let chunkStart = 0;

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    const replacement =
      ch === "T" || ch === "F" || ch === "N"
        ? Object.keys(PYTHON_LITERAL_REPLACEMENTS).find(
            (token) =>
              s.startsWith(token, i) &&
              !IDENTIFIER_CHAR_REGEX.test(s[i - 1] ?? "") &&
              !IDENTIFIER_CHAR_REGEX.test(s[i + token.length] ?? "")
          )
        : undefined;
    if (replacement) {
      out ??= [];
      out.push(
        s.slice(chunkStart, i),
        PYTHON_LITERAL_REPLACEMENTS[replacement]
      );
      i += replacement.length - 1;
      chunkStart = i + 1;
    }
  }

  if (out === null) {
    return s;
  }
  out.push(s.slice(chunkStart));
  return out.join("");
}

function hasPrototypeSensitiveOwnKey(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(hasPrototypeSensitiveOwnKey);
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (COERCE_PROTOTYPE_SENSITIVE_KEYS.has(key)) {
      return true;
    }
    if (hasPrototypeSensitiveOwnKey((value as Record<string, unknown>)[key])) {
      return true;
    }
  }
  return false;
}

/**
 * Parse a string that should have been a structured value: strict JSON,
 * then relaxed JSON (single quotes, unquoted keys), then Python-literal
 * normalization (`True`/`False`/`None` — observed live on KAT Coder Pro).
 */
export function parseLooseStructuredString(s: string): unknown {
  const first = s.trimStart().charAt(0);
  if (first !== "{" && first !== "[") {
    return;
  }
  // Python literals are normalized up front (quote-aware, so string values
  // are untouched); otherwise the relaxed parser would absorb bare `None` /
  // `True` tokens as identifier strings before the normalized candidate ran.
  const normalized = normalizePythonLiterals(s);
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (!hasPrototypeSensitiveOwnKey(parsed)) {
      return parsed;
    }
    return;
  } catch {
    // try relaxed JSON next
  }
  try {
    let foundPrototypeSensitiveKey = false;
    const parsed = parseRJSON(normalized, (key: string, value: unknown) => {
      if (COERCE_PROTOTYPE_SENSITIVE_KEYS.has(key)) {
        foundPrototypeSensitiveKey = true;
        return;
      }
      return value;
    });
    if (foundPrototypeSensitiveKey || hasPrototypeSensitiveOwnKey(parsed)) {
      return;
    }
    return parsed;
  } catch {
    // not parseable as a structured value
  }
}

/**
 * Parse line-oriented `<key>value</key>` children into a record (observed
 * live on Cohere Command R+, which nests XML children inside an object-typed
 * parameter value). Tolerates a missing close tag on a line.
 */
export function parseXmlChildrenValue(
  s: string
): Record<string, unknown> | null {
  const lines = s
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0 || !lines[0].startsWith("<")) {
    return null;
  }
  const record = Object.create(null) as Record<string, unknown>;
  for (const line of lines) {
    const match =
      XML_CHILD_VALUE_CLOSED_RE.exec(line) ??
      XML_CHILD_VALUE_OPEN_RE.exec(line);
    if (!match) {
      return null;
    }
    const [, key] = match;
    if (COERCE_PROTOTYPE_SENSITIVE_KEYS.has(key)) {
      return null;
    }
    // Match the yaml-xml protocol's body fallback: unescape XML entities
    // and merge repeated keys into arrays.
    const value = unescapeXml((match[2] ?? "").trim());
    const existing = record[key];
    if (existing === undefined) {
      record[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      record[key] = [existing, value];
    }
  }
  return record;
}

/**
 * Coerce string to object using schema
 */
