// Utility functions for multi-turn evaluation
// Ported from Python's multi_turn_utils.py

/**
 * Find differences between two instances for error reporting
 */
export function findInstanceDifferences(
  modelInstance: any,
  groundTruthInstance: any
): Record<string, { model: any; ground_truth: any }> {
  const differences: Record<string, { model: any; ground_truth: any }> = {};

  // Get all keys from both instances
  const allKeys = new Set([
    ...Object.keys(modelInstance),
    ...Object.keys(groundTruthInstance),
  ]);

  for (const key of allKeys) {
    // Skip private attributes
    if (key.startsWith("_")) continue;

    const modelValue = modelInstance[key];
    const groundTruthValue = groundTruthInstance[key];

    // Deep comparison
    if (!deepEqual(modelValue, groundTruthValue)) {
      differences[key] = {
        model: modelValue,
        ground_truth: groundTruthValue,
      };
    }
  }

  return differences;
}

/**
 * Deep equality check for complex objects
 */
export function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;

  if (a == null || b == null) return a === b;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (typeof a === "object" && typeof b === "object") {
    const keysA = Object.keys(a).filter((k) => !k.startsWith("_"));
    const keysB = Object.keys(b).filter((k) => !k.startsWith("_"));

    if (keysA.length !== keysB.length) return false;

    for (const key of keysA) {
      if (!keysB.includes(key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }

  return false;
}

/**
 * Sanitize method names for safe execution
 */
export function sanitizeMethodName(methodName: string): string {
  // Remove any potentially dangerous characters
  return methodName.replace(/[^a-zA-Z0-9_]/g, "");
}

/**
 * Validate that a function call string is safe to execute
 */
export function validateFunctionCall(funcCall: string): boolean {
  // Block dangerous operations
  const dangerousPatterns = [
    /\bkill\b/,
    /\bexit\b/,
    /\bquit\b/,
    /\bsystem\b/,
    /\bexec\b/,
    /\beval\b/,
    /\bimport\b/,
    /__\w+__/, // Dunder methods
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(funcCall)) {
      return false;
    }
  }

  return true;
}

/**
 * Normalize response for comparison
 */
export function normalizeResponse(response: string): string {
  // Remove extra whitespace and normalize quotes
  return response.trim().replace(/\s+/g, " ");
}

/**
 * Generate a unique instance key for method registry
 */
export function generateInstanceKey(
  modelName: string,
  testEntryId: string,
  className: string
): string {
  // Sanitize names to create valid identifiers
  const sanitizedModelName = modelName.replace(/[-./]/g, "_");
  const sanitizedTestId = testEntryId.replace(/[-./]/g, "_");
  return `${sanitizedModelName}_${sanitizedTestId}_${className}_instance`;
}
