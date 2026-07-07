import { decodeStructuredTextEscapes } from "./structured-text-escapes";

const YAML_MAPPING_KEY_TEXT_REGEX = /(?:^|\n)\s*[A-Za-z_][A-Za-z0-9_.-]*\s*:/;
const PENDING_SENSITIVE_YAML_KEY_TEXT_REGEX =
  /(?:^|\n)\s*(?:__proto__|constructor|prototype)\s*$/i;

function stringMayBecomeStructuredSensitiveInput(value: string): boolean {
  const trimmed = decodeStructuredTextEscapes(value).trimStart();
  return (
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("<") ||
    YAML_MAPPING_KEY_TEXT_REGEX.test(trimmed) ||
    PENDING_SENSITIVE_YAML_KEY_TEXT_REGEX.test(trimmed)
  );
}

function hasStructuredStringLeaf(value: unknown): boolean {
  const seen = new Set<object>();
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "string") {
      if (stringMayBecomeStructuredSensitiveInput(current)) {
        return true;
      }
      continue;
    }
    if (Array.isArray(current)) {
      if (!seen.has(current)) {
        seen.add(current);
        stack.push(...current);
      }
      continue;
    }
    if (current && typeof current === "object" && !seen.has(current)) {
      seen.add(current);
      stack.push(...Object.values(current));
    }
  }
  return false;
}

export function shouldBufferToolInputProgress(fullInput: string): boolean {
  try {
    return hasStructuredStringLeaf(JSON.parse(fullInput));
  } catch {
    return false;
  }
}
