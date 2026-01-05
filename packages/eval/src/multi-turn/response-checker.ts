// Response checker - validates execution results
// Ported from Python's response_checker function

type ResponseItem =
  | string
  | number
  | boolean
  | null
  | Record<string, unknown>
  | unknown[];

export interface ResponseCheckResult {
  valid: boolean;
  error_type?: string;
  details?: {
    missing_items?: ResponseItem[];
    model_response?: ResponseItem[];
    ground_truth_response?: ResponseItem[];
  };
}

export function responseChecker(
  modelResponseList: ResponseItem[],
  groundTruthResponseList: ResponseItem[],
  _turnIndex: number
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

export function isSubsequenceUnordered(
  groundTruthList: ResponseItem[],
  modelList: ResponseItem[]
): { isSubsequence: boolean; missingItems: ResponseItem[] } {
  if (groundTruthList.length === 0) {
    return { isSubsequence: true, missingItems: [] };
  }

  if (modelList.length === 0) {
    return { isSubsequence: false, missingItems: [...groundTruthList] };
  }

  const remainingModel = [...modelList];
  const missingItems: ResponseItem[] = [];

  for (const groundTruthItem of groundTruthList) {
    let found = false;

    for (let i = 0; i < remainingModel.length; i++) {
      if (itemsEqual(groundTruthItem, remainingModel[i])) {
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

function itemsEqual(a: ResponseItem, b: ResponseItem): boolean {
  if (a == null && b == null) {
    return true;
  }
  if (a == null || b == null) {
    return false;
  }

  if (typeof a === "string" && typeof b === "string") {
    return normalizeResponse(a) === normalizeResponse(b);
  }

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

  return a === b;
}

/**
 * Normalize response string for comparison
 */
function normalizeResponse(response: string): string {
  // Remove extra whitespace and normalize
  return response.trim().replace(/\s+/g, " ");
}

function normalizeObject(obj: ResponseItem): ResponseItem {
  if (obj == null) {
    return obj;
  }
  if (typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => normalizeObject(item as ResponseItem));
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      normalized[key] = normalizeObject(value as ResponseItem);
    }
  }

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(normalized).sort()) {
    sorted[key] = normalized[key];
  }

  return sorted;
}
