// Response checker - validates execution results
// Ported from Python's response_checker function

export interface ResponseCheckResult {
  valid: boolean;
  error_type?: string;
  details?: {
    missing_items?: any[];
    model_response?: any[];
    ground_truth_response?: any[];
  };
}

/**
 * Checks if the model_response is a subsequence of the ground_truth_response.
 * Order-independent matching for parallel operations.
 */
export function responseChecker(
  modelResponseList: any[],
  groundTruthResponseList: any[],
  turnIndex: number
): ResponseCheckResult {
  const isSubsequenceResult = isSubsequenceUnordered(
    groundTruthResponseList,
    modelResponseList
  );

  if (!isSubsequenceResult.isSubsequence) {
    return {
      valid: false,
      error_type: "multi_turn:execution_response_mismatch",
      details: {
        missing_items: isSubsequenceResult.missingItems,
        model_response: modelResponseList,
        ground_truth_response: groundTruthResponseList,
      },
    };
  }

  return { valid: true };
}

/**
 * Check if list A is a subsequence of list B (order-independent)
 * This allows parallel function calls to be executed in any order
 */
export function isSubsequenceUnordered(
  groundTruthList: any[],
  modelList: any[]
): { isSubsequence: boolean; missingItems: any[] } {
  if (groundTruthList.length === 0) {
    return { isSubsequence: true, missingItems: [] };
  }

  if (modelList.length === 0) {
    return { isSubsequence: false, missingItems: [...groundTruthList] };
  }

  // Create copies to avoid modifying originals
  const remainingGroundTruth = [...groundTruthList];
  const remainingModel = [...modelList];
  const missingItems: any[] = [];

  // Greedy matching algorithm
  for (const groundTruthItem of groundTruthList) {
    let found = false;

    for (let i = 0; i < remainingModel.length; i++) {
      if (itemsEqual(groundTruthItem, remainingModel[i])) {
        // Remove the matched item from remaining lists
        remainingModel.splice(i, 1);
        found = true;
        break;
      }
    }

    if (!found) {
      missingItems.push(groundTruthItem);
    }
  }

  return {
    isSubsequence: missingItems.length === 0,
    missingItems,
  };
}

/**
 * Check if two items are equal (handles different types)
 */
function itemsEqual(a: any, b: any): boolean {
  // Handle null/undefined
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;

  // Handle strings
  if (typeof a === "string" && typeof b === "string") {
    return normalizeResponse(a) === normalizeResponse(b);
  }

  // Handle objects (try JSON comparison)
  if (typeof a === "object" && typeof b === "object") {
    try {
      return (
        JSON.stringify(normalizeObject(a)) ===
        JSON.stringify(normalizeObject(b))
      );
    } catch {
      return String(a) === String(b);
    }
  }

  // Handle primitives
  return a === b;
}

/**
 * Normalize response string for comparison
 */
function normalizeResponse(response: string): string {
  // Remove extra whitespace and normalize
  return response.trim().replace(/\s+/g, " ");
}

/**
 * Normalize object for comparison (remove undefined values, sort keys)
 */
function normalizeObject(obj: any): any {
  if (obj == null) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(normalizeObject);

  const normalized: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      normalized[key] = normalizeObject(value);
    }
  }

  // Sort keys for consistent comparison
  const sorted: any = {};
  for (const key of Object.keys(normalized).sort()) {
    sorted[key] = normalized[key];
  }

  return sorted;
}
