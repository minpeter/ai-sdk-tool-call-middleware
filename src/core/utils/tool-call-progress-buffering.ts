import { decodeStructuredTextEscapes } from "./structured-text-escapes";

function stringMayBecomeStructuredSensitiveInput(value: string): boolean {
  const trimmed = decodeStructuredTextEscapes(value).trimStart();
  return (
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("<")
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
