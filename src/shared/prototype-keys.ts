/**
 * Canonical set of JavaScript prototype-chain property names that must be
 * rejected when parsing untrusted model-generated tool call arguments.
 */
export const PROTOTYPE_SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export function isPrototypeSensitiveKey(key: string): boolean {
  return PROTOTYPE_SENSITIVE_KEYS.has(key);
}
