const XML_ENTITY_REGEX = /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/gi;
const XML_NESTED_AMP_ENTITY_REGEX =
  /&(?:amp;)+(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/gi;
const XML_NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};
const MAX_XML_CODE_POINT = 0x10_ff_ff;
const MAX_XML_ENTITY_DECODE_PASSES = 4;

export function decodeJsonUnicodeEscapes(text: string): string {
  return text.replace(/\\+u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
}

function decodeXmlEntity(match: string, entity: string): string {
  const normalized = entity.toLowerCase();
  let codePoint: number | undefined;
  if (normalized.startsWith("#x")) {
    codePoint = Number.parseInt(normalized.slice(2), 16);
  } else if (normalized.startsWith("#")) {
    codePoint = Number.parseInt(normalized.slice(1), 10);
  }
  if (
    codePoint !== undefined &&
    Number.isInteger(codePoint) &&
    codePoint >= 0 &&
    codePoint <= MAX_XML_CODE_POINT
  ) {
    return String.fromCodePoint(codePoint);
  }
  return XML_NAMED_ENTITIES[normalized] ?? match;
}

function decodeXmlEntities(text: string): string {
  let decoded = text;
  for (let pass = 0; pass < MAX_XML_ENTITY_DECODE_PASSES; pass += 1) {
    const next = decoded
      .replace(XML_NESTED_AMP_ENTITY_REGEX, decodeXmlEntity)
      .replace(XML_ENTITY_REGEX, decodeXmlEntity);
    if (next === decoded) {
      return decoded;
    }
    decoded = next;
  }
  return decoded;
}

export function decodeStructuredTextEscapes(text: string): string {
  return decodeJsonUnicodeEscapes(
    decodeXmlEntities(decodeJsonUnicodeEscapes(text))
  );
}
