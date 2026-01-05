interface InstanceDifference {
  model: unknown;
  ground_truth: unknown;
}

const DANGEROUS_PATTERNS = [
  /\bkill\b/,
  /\bexit\b/,
  /\bquit\b/,
  /\bsystem\b/,
  /\bexec\b/,
  /\beval\b/,
  /\bimport\b/,
  /__\w+__/,
];

export function findInstanceDifferences(
  modelInstance: Record<string, unknown>,
  groundTruthInstance: Record<string, unknown>
): Record<string, InstanceDifference> {
  const differences: Record<string, InstanceDifference> = {};

  // Get all keys from both instances
  const allKeys = new Set([
    ...Object.keys(modelInstance),
    ...Object.keys(groundTruthInstance),
  ]);

  for (const key of allKeys) {
    // Skip private attributes
    if (key.startsWith("_")) {
      continue;
    }

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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Deep equality check requires type-based branching
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }

  if (a == null || b == null) {
    return a === b;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }

  if (typeof a === "object" && typeof b === "object") {
    const objA = a as Record<string, unknown>;
    const objB = b as Record<string, unknown>;
    const keysA = Object.keys(objA).filter((k) => !k.startsWith("_"));
    const keysB = Object.keys(objB).filter((k) => !k.startsWith("_"));

    if (keysA.length !== keysB.length) {
      return false;
    }

    for (const key of keysA) {
      if (!keysB.includes(key)) {
        return false;
      }
      if (!deepEqual(objA[key], objB[key])) {
        return false;
      }
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
  for (const pattern of DANGEROUS_PATTERNS) {
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
