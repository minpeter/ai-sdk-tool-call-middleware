// State checker - validates instance states after execution
// Ported from Python's state_checker function

export interface StateCheckResult {
  valid: boolean;
  error_type?: string;
  details?: {
    differences?: Record<string, any>;
    model_instance_state?: Record<string, any>;
    ground_truth_instance_state?: Record<string, any>;
  };
}

/**
 * Checks if, after executing the function calls, the model_instance
 * has the same state (defined by the attributes) as the ground_truth_instance.
 */
export function stateChecker(
  modelInstances: Record<string, any>,
  groundTruthInstances: Record<string, any>
): StateCheckResult {
  for (const [className, groundTruthInstance] of Object.entries(
    groundTruthInstances
  )) {
    const modelInstance = modelInstances[className];

    if (!modelInstance) {
      return {
        valid: false,
        error_type: "multi_turn:instance_state_mismatch",
        details: {
          differences: { [className]: "Instance not found in model instances" },
        },
      };
    }

    const comparisonResult = compareInstances(
      modelInstance,
      groundTruthInstance
    );

    if (!comparisonResult.valid) {
      return {
        valid: false,
        error_type: "multi_turn:instance_state_mismatch",
        details: {
          differences: comparisonResult.differences,
          model_instance_state: serializeInstanceState(modelInstance),
          ground_truth_instance_state:
            serializeInstanceState(groundTruthInstance),
        },
      };
    }
  }

  return { valid: true };
}

/**
 * Compare all non-private attributes of two instances
 */
function compareInstances(
  modelObject: any,
  groundTruthObject: any
): {
  valid: boolean;
  differences: Record<string, any>;
} {
  const differences: Record<string, any> = {};

  const SKIP_ATTRS = new Set(["parent", "_parent"]);
  for (const attrName of Object.keys(groundTruthObject)) {
    if (attrName.startsWith("_") || SKIP_ATTRS.has(attrName)) {
      continue;
    }

    const modelAttr = modelObject[attrName];
    const groundTruthAttr = groundTruthObject[attrName];

    // Deep comparison for objects and arrays
    if (!deepEqual(modelAttr, groundTruthAttr)) {
      differences[attrName] = {
        model: modelAttr,
        ground_truth: groundTruthAttr,
      };
    }
  }

  return {
    valid: Object.keys(differences).length === 0,
    differences,
  };
}

const SKIP_KEYS = new Set(["parent", "_parent"]);

function deepEqual(
  a: any,
  b: any,
  seen: WeakSet<object> = new WeakSet()
): boolean {
  if (a === b) return true;

  if (a == null || b == null) return a === b;

  if (typeof a !== typeof b) return false;

  if (typeof a !== "object") return a === b;

  if (seen.has(a) || seen.has(b)) return true;
  seen.add(a);
  if (typeof b === "object") seen.add(b);

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i], seen)) return false;
    }
    return true;
  }

  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const keysA = Object.keys(a).filter(
    (k) => !(k.startsWith("_") || SKIP_KEYS.has(k))
  );
  const keysB = Object.keys(b).filter(
    (k) => !(k.startsWith("_") || SKIP_KEYS.has(k))
  );

  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!keysB.includes(key)) return false;
    if (!deepEqual(a[key], b[key], seen)) return false;
  }
  return true;
}

/**
 * Serialize instance state for error reporting
 */
function serializeInstanceState(instance: any): Record<string, any> {
  const state: Record<string, any> = {};

  for (const [key, value] of Object.entries(instance)) {
    if (!key.startsWith("_")) {
      try {
        // Try to serialize, fallback to string representation
        state[key] =
          typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value;
      } catch {
        state[key] = String(value);
      }
    }
  }

  return state;
}
