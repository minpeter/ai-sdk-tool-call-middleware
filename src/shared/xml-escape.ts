const XML_ESCAPE_CANDIDATE_REGEX = /[&<>"']/;
const XML_MINIMAL_TEXT_CANDIDATE_REGEX = /[&<>]/;
const XML_MINIMAL_ATTR_CANDIDATE_REGEX = /[&<"']/;
const XML_CHAR_REF_REGEX = /&#(?:x([0-9a-fA-F]+)|(\d+));/g;
const MAX_XML_CODE_POINT = 0x10_ff_ff;

/**
 * Escape XML special characters used in element content and attribute values.
 *
 * References (W3C XML 1.0, Fifth Edition):
 * - 2.4 Character Data and Markup: '<' and '&' MUST NOT appear literally in content;
 *   they MUST be escaped. '>' MUST be escaped in the sequence ']]>' and MAY be
 *   escaped otherwise. Spec: https://www.w3.org/TR/2008/REC-xml-20081126/
 * - 3.1 Start-Tags, End-Tags, and Empty-Element Tags (AttValue [10]): attribute
 *   values are quoted with ' or ", and the matching quote MUST be escaped inside.
 * - 4.6 Predefined Entities: amp, lt, gt, apos, quot MUST be recognized by all
 *   XML processors. Spec: https://www.w3.org/TR/2008/REC-xml-20081126/#sec-predefined-ent
 *
 * We conservatively escape &, <, >, ", ' using the predefined entities.
 */
export function escapeXml(text: string): string {
  // Fast path: most content has no escapable characters; skip the five
  // replace passes (and their intermediate allocations) entirely.
  if (!XML_ESCAPE_CANDIDATE_REGEX.test(text)) {
    return text;
  }
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Minimal escaping for character data per XML 1.0 §2.4.
 * - Escape '&' and '<' always
 * - Escape only the ']]>' sequence by turning '>' into '&gt;' in that context
 */
export function escapeXmlMinimalText(text: string): string {
  // Fast path: no '&', '<', or '>' means neither the always-escaped
  // characters nor the ']]>' sequence can occur.
  if (!XML_MINIMAL_TEXT_CANDIDATE_REGEX.test(text)) {
    return text;
  }
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/]]>/g, "]]&gt;");
}

/**
 * Minimal escaping for attribute values per XML 1.0 §3.1 (AttValue [10]).
 * - Escape '&' and '<' always
 * - Escape only the wrapper quote among ' or "
 */
export function escapeXmlMinimalAttr(
  value: string,
  wrapper: '"' | "'" = '"'
): string {
  // Fast path: no escapable character for either wrapper quote style.
  if (!XML_MINIMAL_ATTR_CANDIDATE_REGEX.test(value)) {
    return value;
  }
  let escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  if (wrapper === '"') {
    escaped = escaped.replace(/"/g, "&quot;");
  } else {
    escaped = escaped.replace(/'/g, "&apos;");
  }
  return escaped;
}

function decodeXmlCharacterReference(
  match: string,
  hex: string | undefined,
  decimal: string | undefined
): string {
  const codePoint =
    hex === undefined
      ? Number.parseInt(decimal ?? "", 10)
      : Number.parseInt(hex, 16);
  if (
    Number.isInteger(codePoint) &&
    codePoint >= 0 &&
    codePoint <= MAX_XML_CODE_POINT
  ) {
    return String.fromCodePoint(codePoint);
  }
  return match;
}

/**
 * Unescape XML entities and numeric character references.
 */
export function unescapeXml(text: string): string {
  // Fast path: every entity and character reference starts with '&'.
  if (!text.includes("&")) {
    return text;
  }
  return text
    .replace(XML_CHAR_REF_REGEX, decodeXmlCharacterReference)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
