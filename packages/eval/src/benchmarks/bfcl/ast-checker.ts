// Local ToolCall interface for type safety, as it's not exported from 'ai'.
export interface ToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

// --- Type Definitions ---
export interface FunctionDescription {
  name: string;
  description?: string;
  parameters: {
    type: "object";
    properties: {
      [key: string]: {
        type: string;
        description?: string;
        items?: { type: string };
      };
    };
    required: string[];
  };
}

/**
 * Standardizes a string for comparison.
 */
function standardizeString(input: string): string {
  if (typeof input !== "string") return input;
  const regex = /[ ,./\\-_*^]/g;
  return input.replace(regex, "").toLowerCase().replace(/'/g, '"');
}

/**
 * Checks a string value against possible answers.
 */
function checkStringValue(
  param: string,
  modelValue: string,
  possibleAnswers: unknown[]
): { valid: boolean; error?: string; error_type?: string } {
  const standardizedModelValue = standardizeString(modelValue);
  const standardizedPossibleAnswers = possibleAnswers.map(ans =>
    standardizeString(String(ans))
  );

  if (!standardizedPossibleAnswers.includes(standardizedModelValue)) {
    return {
      valid: false,
      error: `Invalid value for parameter '${param}': ${JSON.stringify(
        modelValue
      )}. Expected one of ${JSON.stringify(possibleAnswers)}.`,
      error_type: "value_error:string",
    };
  }
  return { valid: true };
}

/**
 * Main checker for a single function call.
 * Aligned with the `ai` package's `ToolCall` type.
 */
export function simpleFunctionChecker(
  funcDescription: FunctionDescription,
  modelToolCall: ToolCall,
  possibleAnswer: Record<string, unknown>
): { valid: boolean; error?: string; error_type?: string } {
  const modelArgs = modelToolCall.args;
  const modelFuncName = modelToolCall.toolName;
  const expectedFuncName = funcDescription.name;
  const expectedParams = funcDescription.parameters.properties;
  const requiredParams = funcDescription.parameters.required;

  if (modelFuncName !== expectedFuncName) {
    return {
      valid: false,
      error: `Function name '${modelFuncName}' does not match expected '${expectedFuncName}'.`,
      error_type: "simple_function_checker:wrong_func_name",
    };
  }

  const possibleAnswerParams = possibleAnswer[
    Object.keys(possibleAnswer)[0]
  ] as Record<string, unknown>;

  const argsObj: Record<string, unknown> =
    modelArgs && typeof modelArgs === "object"
      ? (modelArgs as Record<string, unknown>)
      : {};

  for (const param of requiredParams) {
    if (!(param in argsObj)) {
      return {
        valid: false,
        error: `Missing required parameter: '${param}'.`,
        error_type: "simple_function_checker:missing_required",
      };
    }
  }

  if (modelArgs && typeof modelArgs === "object") {
    for (const paramName of Object.keys(argsObj)) {
      const modelValue = argsObj[paramName];
      if (
        !(paramName in expectedParams) ||
        !(paramName in possibleAnswerParams)
      ) {
        return {
          valid: false,
          error: `Unexpected parameter: '${paramName}'.`,
          error_type: "simple_function_checker:unexpected_param",
        };
      }

      const possibleValues = possibleAnswerParams[paramName] as unknown;

      if (typeof modelValue === "string") {
        const result = checkStringValue(
          paramName,
          modelValue,
          (possibleValues as unknown[] | undefined) ?? []
        );
        if (!result.valid) return result;
      } else if (Array.isArray(modelValue)) {
        const modelValueStr = JSON.stringify(
          modelValue.map(v => standardizeString(String(v))).sort()
        );
        const hasMatch = Array.isArray(possibleValues)
          ? (possibleValues as unknown[]).some(p => {
              if (!Array.isArray(p)) return false;
              return (
                JSON.stringify(
                  p.map(v => standardizeString(String(v))).sort()
                ) === modelValueStr
              );
            })
          : false;
        if (!hasMatch) {
          return {
            valid: false,
            error: `Invalid value for list parameter '${paramName}'. Got ${JSON.stringify(
              modelValue
            )}. Expected one of ${JSON.stringify(possibleValues)}.`,
            error_type: "value_error:list",
          };
        }
      } else {
        // Handle nested objects by comparing JSON representations
        const hasMatch = Array.isArray(possibleValues)
          ? (possibleValues as unknown[]).some(possibleValue => {
              // Direct equality check first
              if (modelValue === possibleValue) return true;

              // For objects, perform deep comparison via JSON serialization
              if (
                typeof modelValue === "object" &&
                modelValue !== null &&
                typeof possibleValue === "object" &&
                possibleValue !== null
              ) {
                try {
                  // Handle BFCL dataset quirk where object property values are wrapped in arrays
                  // e.g. {"min": [300000], "max": [400000]} should match {"min": 300000, "max": 400000}
                  const normalizeObject = (obj: unknown): unknown => {
                    if (Array.isArray(obj)) {
                      return obj.map(normalizeObject);
                    }
                    if (obj && typeof obj === "object") {
                      const normalized: Record<string, unknown> = {};
                      for (const [key, value] of Object.entries(
                        obj as Record<string, unknown>
                      )) {
                        // If value is a single-element array, unwrap it
                        if (
                          Array.isArray(value) &&
                          value.length === 1 &&
                          (typeof value[0] !== "object" || value[0] === null)
                        ) {
                          normalized[key] = value[0];
                        } else {
                          normalized[key] = normalizeObject(value);
                        }
                      }
                      return normalized;
                    }
                    return obj;
                  };

                  const normalizedModel = normalizeObject(modelValue);
                  const normalizedPossible = normalizeObject(possibleValue);

                  return (
                    JSON.stringify(normalizedModel) ===
                    JSON.stringify(normalizedPossible)
                  );
                } catch {
                  return false;
                }
              }

              // For numbers, handle string/number conversion
              if (
                typeof modelValue === "number" &&
                typeof possibleValue === "string"
              ) {
                return modelValue.toString() === possibleValue;
              }
              if (
                typeof modelValue === "string" &&
                typeof possibleValue === "number"
              ) {
                return modelValue === possibleValue.toString();
              }

              return false;
            })
          : false;

        if (!hasMatch) {
          return {
            valid: false,
            error: `Invalid value for parameter '${paramName}'. Got ${JSON.stringify(
              modelValue
            )}. Expected one of ${JSON.stringify(possibleValues)}.`,
            error_type: "value_error:other",
          };
        }
      }
    }
  }

  for (const paramName in possibleAnswerParams) {
    const val = possibleAnswerParams[paramName] as unknown;
    const isOptional = Array.isArray(val) && val.includes("");
    if (!(paramName in argsObj) && !isOptional) {
      return {
        valid: false,
        error: `Missing optional parameter '${paramName}' which was not marked as optional.`,
        error_type: "simple_function_checker:missing_optional",
      };
    }
  }

  return { valid: true };
}

/**
 * Checker for parallel function calls (order-agnostic).
 */
export function parallelFunctionCheckerNoOrder(
  funcDescriptions: FunctionDescription[],
  modelToolCalls: ToolCall[],
  possibleAnswers: Record<string, unknown>[]
): { valid: boolean; error?: string; error_type?: string } {
  if (modelToolCalls.length !== possibleAnswers.length) {
    return {
      valid: false,
      error: `Wrong number of functions. Expected ${possibleAnswers.length}, got ${modelToolCalls.length}.`,
      error_type: "parallel_function_checker_no_order:wrong_count",
    };
  }

  const matchedModelCallIndices = new Set<number>();
  for (const possibleAnswer of possibleAnswers) {
    const expectedFuncName = Object.keys(possibleAnswer)[0];
    const funcDescription = funcDescriptions.find(
      f => f.name === expectedFuncName
    );

    if (!funcDescription) {
      return {
        valid: false,
        error: `Could not find function description for '${expectedFuncName}'.`,
        error_type: "parallel_function_checker_no_order:missing_func_desc",
      };
    }

    let foundMatch = false;
    for (let i = 0; i < modelToolCalls.length; i++) {
      if (matchedModelCallIndices.has(i)) continue;

      const checkerResult = simpleFunctionChecker(
        funcDescription,
        modelToolCalls[i],
        possibleAnswer
      );
      if (checkerResult.valid) {
        matchedModelCallIndices.add(i);
        foundMatch = true;
        break;
      }
    }

    if (!foundMatch) {
      return {
        valid: false,
        error: `Could not find a matching function call for '${expectedFuncName}'.`,
        error_type: "parallel_function_checker_no_order:cannot_find_match",
      };
    }
  }
  return { valid: true };
}

/**
 * Checker for multiple calls to the same function.
 */
export function multipleFunctionChecker(
  funcDescriptions: FunctionDescription[],
  modelToolCalls: ToolCall[],
  possibleAnswers: Record<string, unknown>[]
): { valid: boolean; error?: string; error_type?: string } {
  if (modelToolCalls.length !== possibleAnswers.length) {
    return {
      valid: false,
      error: `Wrong number of functions. Expected ${possibleAnswers.length}, got ${modelToolCalls.length}.`,
      error_type: "multiple_function_checker:wrong_count",
    };
  }

  const expectedFuncName = Object.keys(possibleAnswers[0])[0];
  const funcDescription = funcDescriptions.find(
    f => f.name === expectedFuncName
  );

  if (!funcDescription) {
    return {
      valid: false,
      error: `Could not find function description for '${expectedFuncName}'.`,
      error_type: "multiple_function_checker:missing_func_desc",
    };
  }

  return simpleFunctionChecker(
    funcDescription,
    modelToolCalls[0],
    possibleAnswers[0]
  );
}
