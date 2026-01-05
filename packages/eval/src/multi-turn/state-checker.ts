// State checker - validates instance states after execution
// Ported from Python's state_checker function

import { Directory, File } from "./classes/gorilla-file-system";

/**
 * Represents serialized state of any value for comparison
 */
type SerializedValue =
  | string
  | number
  | boolean
  | null
  | SerializedObject
  | SerializedValue[];
interface SerializedObject {
  [key: string]: SerializedValue;
}

export interface StateCheckResult {
  valid: boolean;
  error_type?: string;
  details?: {
    differences?: Record<string, SerializedValue>;
    model_instance_state?: Record<string, SerializedValue>;
    ground_truth_instance_state?: Record<string, SerializedValue>;
  };
}

/**
 * Checks if, after executing the function calls, the model_instance
 * has the same state (defined by the attributes) as the ground_truth_instance.
 */
export function stateChecker(
  // biome-ignore lint/suspicious/noExplicitAny: Runtime type comparison requires dynamic property access
  modelInstances: Record<string, any>,
  // biome-ignore lint/suspicious/noExplicitAny: Runtime type comparison requires dynamic property access
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
      // Debug: 더 자세한 상태 차이 출력
      console.log("[DEBUG] State mismatch detected!");
      console.log(
        "[DEBUG] Differences:",
        JSON.stringify(comparisonResult.differences, null, 2)
      );
      console.log(
        "[DEBUG] Model instance state:",
        JSON.stringify(serializeInstanceState(modelInstance), null, 2)
      );
      console.log(
        "[DEBUG] Ground truth instance state:",
        JSON.stringify(serializeInstanceState(groundTruthInstance), null, 2)
      );

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

function compareInstances(
  // biome-ignore lint/suspicious/noExplicitAny: Dynamic property enumeration for runtime comparison
  modelObject: any,
  // biome-ignore lint/suspicious/noExplicitAny: Dynamic property enumeration for runtime comparison
  groundTruthObject: any
): {
  valid: boolean;
  differences: Record<string, SerializedValue>;
} {
  const differences: Record<string, SerializedValue> = {};

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

function shouldSkipKey(key: string): boolean {
  return key.startsWith("_") || SKIP_KEYS.has(key);
}

function getFilteredKeys(obj: object): string[] {
  return Object.keys(obj).filter((k) => !shouldSkipKey(k));
}

function deepEqualArrays(
  // biome-ignore lint/suspicious/noExplicitAny: Array element comparison
  a: any[],
  // biome-ignore lint/suspicious/noExplicitAny: Array element comparison
  b: any[],
  seen: WeakSet<object>
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (!deepEqual(a[i], b[i], seen)) {
      return false;
    }
  }
  return true;
}

function deepEqualObjects(
  // biome-ignore lint/suspicious/noExplicitAny: Object property comparison
  a: any,
  // biome-ignore lint/suspicious/noExplicitAny: Object property comparison
  b: any,
  seen: WeakSet<object>
): boolean {
  const keysA = getFilteredKeys(a);
  const keysB = getFilteredKeys(b);

  if (keysA.length !== keysB.length) {
    return false;
  }

  for (const key of keysA) {
    if (!keysB.includes(key)) {
      return false;
    }
    if (!deepEqual(a[key], b[key], seen)) {
      return false;
    }
  }
  return true;
}

function deepEqual(
  // biome-ignore lint/suspicious/noExplicitAny: Deep equality check on unknown runtime types
  a: any,
  // biome-ignore lint/suspicious/noExplicitAny: Deep equality check on unknown runtime types
  b: any,
  seen: WeakSet<object> = new WeakSet()
): boolean {
  if (a === b) {
    return true;
  }
  if (a == null || b == null) {
    return a === b;
  }
  if (typeof a !== typeof b) {
    return false;
  }
  if (typeof a !== "object") {
    return a === b;
  }

  if (seen.has(a) || seen.has(b)) {
    return true;
  }
  seen.add(a);
  if (typeof b === "object") {
    seen.add(b);
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    return deepEqualArrays(a, b, seen);
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }

  return deepEqualObjects(a, b, seen);
}

function serializeInstanceState(
  // biome-ignore lint/suspicious/noExplicitAny: Serializes unknown instance types for error reporting
  instance: any
): Record<string, SerializedValue> {
  const state: Record<string, SerializedValue> = {};

  for (const [key, value] of Object.entries(instance)) {
    if (!key.startsWith("_")) {
      try {
        if (key === "root" && typeof value === "object") {
          state[key] = serializeDirectory(value);
        } else {
          state[key] =
            typeof value === "object"
              ? JSON.parse(JSON.stringify(value))
              : (value as SerializedValue);
        }
      } catch {
        state[key] = String(value);
      }
    }
  }

  return state;
}

// biome-ignore lint/suspicious/noExplicitAny: Handles Directory instances with dynamic contents property
function serializeDirectory(dir: any, depth = 0): SerializedObject {
  if (depth > 5) {
    return { value: "[Max depth reached]" };
  }

  const result: SerializedObject = {
    name: dir.name,
    contents: {},
  };

  const contents = result.contents as Record<string, SerializedObject>;
  for (const [name, item] of Object.entries(dir.contents || {})) {
    if (item instanceof File) {
      contents[name] = { type: "file", content: item.content };
    } else if (item instanceof Directory) {
      contents[name] = serializeDirectory(item, depth + 1);
    }
  }

  return result;
}
