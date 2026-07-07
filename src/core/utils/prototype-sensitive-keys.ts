import { parse as parseRJSON } from "../../rjson";

const PROTOTYPE_SENSITIVE_ARGUMENT_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const PROTOTYPE_SENSITIVE_JSON_KEY_TEXT_REGEX =
  /\\?["'](?:__proto__|constructor|prototype)\\?["']\s*:|[{,]\s*(?:__proto__|constructor|prototype)\s*:/;
const PROTOTYPE_SENSITIVE_TEXT_REGEX =
  /\\?["'](?:__proto__|constructor|prototype)\\?["']\s*:|[{,]\s*(?:__proto__|constructor|prototype)\s*:|<\s*(?:__proto__|constructor|prototype)(?:\s|>|\/|$)|<\s*(?:parameter|param|argument|arg)\s*=\s*["']?(?:__proto__|constructor|prototype)(?:["']?\s|["']?>|$)|<\s*(?:parameter|param|argument|arg)\b(?=[^>]*\bname\s*=\s*["']\s*(?:__proto__|constructor|prototype)\s*["'])|<\s*(?:parameter|param|argument|arg)\s*>\s*(?:__proto__|constructor|prototype)\s*<\s*\/\s*(?:parameter|param|argument|arg)\s*>|(?:^|\n)\s*(?:__proto__|constructor|prototype)\s*:/;
const PROTOTYPE_SENSITIVE_YAML_KEY_TEXT_REGEX =
  /^(?:__proto__|constructor|prototype)\s*:/;
const XML_ENTITY_REGEX = /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/gi;
const XML_NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};
const MAX_XML_CODE_POINT = 0x10_ff_ff;

type JsonParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

type RelaxedJsonParseResult =
  | {
      readonly ok: true;
      readonly sawPrototypeSensitiveKey: boolean;
      readonly value: unknown;
    }
  | { readonly ok: false; readonly sawPrototypeSensitiveKey: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function markUnseen(value: object, seen: Set<object>): boolean {
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  return true;
}

function enqueueArrayItems(
  value: unknown,
  seen: Set<object>,
  stack: unknown[]
): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  if (markUnseen(value, seen)) {
    stack.push(...value);
  }
  return true;
}

function hasUnsafePrototype(record: Record<string, unknown>): boolean {
  const prototype = Object.getPrototypeOf(record);
  return prototype !== null && prototype !== Object.prototype;
}

function enqueueRecordOwnValues(
  record: Record<string, unknown>,
  stack: unknown[]
): boolean {
  for (const key of Object.getOwnPropertyNames(record)) {
    if (
      isPrototypeSensitiveArgumentKey(key) ||
      isPrototypeSensitiveArgumentKey(decodeJsonUnicodeEscapes(key))
    ) {
      return true;
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor && "value" in descriptor) {
      stack.push(descriptor.value);
    }
  }
  return false;
}

function decodeJsonUnicodeEscapes(text: string): string {
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
  return text.replace(XML_ENTITY_REGEX, decodeXmlEntity);
}

function decodeStructuredTextEscapes(text: string): string {
  return decodeJsonUnicodeEscapes(
    decodeXmlEntities(decodeJsonUnicodeEscapes(text))
  );
}

function parseJsonText(text: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { ok: false };
    }
    throw error;
  }
}

function parseRelaxedJsonText(text: string): RelaxedJsonParseResult {
  let sawPrototypeSensitiveKey = false;
  try {
    const parsed = parseRJSON(text, {
      relaxed: true,
      reviver: (key, value) => {
        if (isPrototypeSensitiveArgumentKey(key)) {
          sawPrototypeSensitiveKey = true;
          return;
        }
        return value;
      },
    });
    return { ok: true, sawPrototypeSensitiveKey, value: parsed };
  } catch (error) {
    if (error instanceof Error) {
      return { ok: false, sawPrototypeSensitiveKey };
    }
    throw error;
  }
}

export function isPrototypeSensitiveArgumentKey(key: string): boolean {
  return PROTOTYPE_SENSITIVE_ARGUMENT_KEYS.has(key);
}

export function toolCallTextHasPrototypeSensitiveKey(text: string): boolean {
  return PROTOTYPE_SENSITIVE_TEXT_REGEX.test(decodeStructuredTextEscapes(text));
}

function stringLeafHasPrototypeSensitiveArgumentKey(text: string): boolean {
  const decoded = decodeStructuredTextEscapes(text).trimStart();
  const looksJsonLike = decoded.startsWith("{") || decoded.startsWith("[");
  if (looksJsonLike) {
    const json = parseJsonText(text);
    if (json.ok) {
      return hasPrototypeSensitiveArgumentValue(json.value);
    }
    const relaxedJson = parseRelaxedJsonText(text);
    if (relaxedJson.sawPrototypeSensitiveKey) {
      return true;
    }
    if (relaxedJson.ok) {
      return hasPrototypeSensitiveArgumentValue(relaxedJson.value);
    }
  }
  const looksStructured =
    looksJsonLike ||
    decoded.startsWith("<") ||
    PROTOTYPE_SENSITIVE_YAML_KEY_TEXT_REGEX.test(decoded);
  if (!looksStructured) {
    return false;
  }
  return toolCallTextHasPrototypeSensitiveKey(text);
}

export function hasPrototypeSensitiveStructuralKey(value: unknown): boolean {
  const seen = new Set<object>();
  const stack: unknown[] = [value];

  while (stack.length > 0) {
    const current = stack.pop();
    if (enqueueArrayItems(current, seen, stack)) {
      continue;
    }
    if (!isRecord(current)) {
      continue;
    }
    if (!markUnseen(current, seen)) {
      continue;
    }
    if (hasUnsafePrototype(current)) {
      return true;
    }
    if (enqueueRecordOwnValues(current, stack)) {
      return true;
    }
  }

  return false;
}

function hasPrototypeSensitiveArgumentValue(value: unknown): boolean {
  const seen = new Set<object>();
  const stack: unknown[] = [value];

  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "string") {
      if (stringLeafHasPrototypeSensitiveArgumentKey(current)) {
        return true;
      }
      continue;
    }
    if (enqueueArrayItems(current, seen, stack)) {
      continue;
    }
    if (!isRecord(current)) {
      continue;
    }
    if (!markUnseen(current, seen)) {
      continue;
    }
    if (hasUnsafePrototype(current)) {
      return true;
    }
    if (enqueueRecordOwnValues(current, stack)) {
      return true;
    }
  }

  return false;
}

export function toolCallInputHasPrototypeSensitiveKey(input: unknown): boolean {
  if (typeof input !== "string") {
    return hasPrototypeSensitiveArgumentValue(input);
  }
  const json = parseJsonText(input);
  if (json.ok) {
    return hasPrototypeSensitiveArgumentValue(json.value);
  }
  const relaxedJson = parseRelaxedJsonText(input);
  if (relaxedJson.sawPrototypeSensitiveKey) {
    return true;
  }
  if (relaxedJson.ok) {
    return hasPrototypeSensitiveArgumentValue(relaxedJson.value);
  }
  return (
    PROTOTYPE_SENSITIVE_JSON_KEY_TEXT_REGEX.test(input) ||
    toolCallTextHasPrototypeSensitiveKey(input)
  );
}
