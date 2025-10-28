// Local ToolCall interface for type safety, as it's not exported from 'ai'.
export type ToolCall = {
  toolCallId: string;
  toolName: string;
  args: unknown;
};

// --- Type Definitions ---
export type FunctionDescription = {
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
};

/**
 * Standardizes a string for comparison.
 */
function standardizeString(input: string): string {
  if (typeof input !== "string") {
    return input;
  }
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
  const standardizedPossibleAnswers = possibleAnswers.map((ans) =>
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
 * Normalizes objects by unwrapping single-element arrays (BFCL dataset quirk)
 */
function normalizeObject(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(normalizeObject);
  }
  if (obj && typeof obj === "object") {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
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
}

/**
 * Checks if two values match, handling objects, numbers, and strings
 */
function valuesMatch(modelValue: unknown, possibleValue: unknown): boolean {
  // Direct equality check first
  if (modelValue === possibleValue) {
    return true;
  }

  // For objects, perform deep comparison via JSON serialization
  if (
    typeof modelValue === "object" &&
    modelValue !== null &&
    typeof possibleValue === "object" &&
    possibleValue !== null
  ) {
    try {
      const normalizedModel = normalizeObject(modelValue);
      const normalizedPossible = normalizeObject(possibleValue);
      return (
        JSON.stringify(normalizedModel) === JSON.stringify(normalizedPossible)
      );
    } catch {
      return false;
    }
  }

  // For numbers, handle string/number conversion
  if (typeof modelValue === "number" && typeof possibleValue === "string") {
    return modelValue.toString() === possibleValue;
  }
  if (typeof modelValue === "string" && typeof possibleValue === "number") {
    return modelValue === possibleValue.toString();
  }

  return false;
}

/**
 * Checks array parameter values
 */
function checkArrayValue(
  paramName: string,
  modelValue: unknown[],
  possibleValues: unknown
): { valid: boolean; error?: string; error_type?: string } {
  const modelValueStr = JSON.stringify(
    modelValue.map((v) => standardizeString(String(v))).sort()
  );
  const hasMatch = Array.isArray(possibleValues)
    ? (possibleValues as unknown[]).some((p) => {
        if (!Array.isArray(p)) {
          return false;
        }
        return (
          JSON.stringify(p.map((v) => standardizeString(String(v))).sort()) ===
          modelValueStr
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
  return { valid: true };
}

/**
 * Checks object/other parameter values
 */
function checkObjectValue(
  paramName: string,
  modelValue: unknown,
  possibleValues: unknown
): { valid: boolean; error?: string; error_type?: string } {
  const hasMatch = Array.isArray(possibleValues)
    ? (possibleValues as unknown[]).some((possibleValue) =>
        valuesMatch(modelValue, possibleValue)
      )
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
  return { valid: true };
}

type CheckerResult = { valid: boolean; error?: string; error_type?: string };

type CheckerContext = {
  funcDescription: FunctionDescription;
  modelToolCall: ToolCall;
  possibleAnswerParams: Record<string, unknown>;
  expectedParams: Record<
    string,
    { type: string; description?: string; items?: { type: string } }
  >;
};

/**
 * Main checker for a single function call.
 * Aligned with the `ai` package's `ToolCall` type.
 */
export function simpleFunctionChecker(
  funcDescription: FunctionDescription,
  modelToolCall: ToolCall,
  possibleAnswer: Record<string, unknown>
): CheckerResult {
  const funcNameCheck = checkFunctionName(
    funcDescription.name,
    modelToolCall.toolName
  );
  if (!funcNameCheck.valid) {
    return funcNameCheck;
  }

  const possibleAnswerParams = possibleAnswer[
    Object.keys(possibleAnswer)[0]
  ] as Record<string, unknown>;

  const argsObj: Record<string, unknown> =
    modelToolCall.args && typeof modelToolCall.args === "object"
      ? (modelToolCall.args as Record<string, unknown>)
      : {};

  const context: CheckerContext = {
    funcDescription,
    modelToolCall,
    possibleAnswerParams,
    expectedParams: funcDescription.parameters.properties,
  };

  const requiredCheck = checkRequiredParams(
    funcDescription.parameters.required,
    argsObj
  );
  if (!requiredCheck.valid) {
    return requiredCheck;
  }

  const paramsCheck = checkAllParameters(argsObj, context);
  if (!paramsCheck.valid) {
    return paramsCheck;
  }

  const optionalCheck = checkOptionalParams(argsObj, possibleAnswerParams);
  if (!optionalCheck.valid) {
    return optionalCheck;
  }

  return { valid: true };
}

function checkFunctionName(expected: string, actual: string): CheckerResult {
  if (actual !== expected) {
    return {
      valid: false,
      error: `Function name '${actual}' does not match expected '${expected}'.`,
      error_type: "simple_function_checker:wrong_func_name",
    };
  }
  return { valid: true };
}

function checkRequiredParams(
  requiredParams: string[],
  argsObj: Record<string, unknown>
): CheckerResult {
  for (const param of requiredParams) {
    if (!(param in argsObj)) {
      return {
        valid: false,
        error: `Missing required parameter: '${param}'.`,
        error_type: "simple_function_checker:missing_required",
      };
    }
  }
  return { valid: true };
}

function checkAllParameters(
  argsObj: Record<string, unknown>,
  context: CheckerContext
): CheckerResult {
  for (const paramName of Object.keys(argsObj)) {
    const paramCheck = checkSingleParameter(
      paramName,
      argsObj[paramName],
      context
    );
    if (!paramCheck.valid) {
      return paramCheck;
    }
  }
  return { valid: true };
}

function checkSingleParameter(
  paramName: string,
  modelValue: unknown,
  context: CheckerContext
): CheckerResult {
  if (
    !(
      paramName in context.expectedParams &&
      paramName in context.possibleAnswerParams
    )
  ) {
    return {
      valid: false,
      error: `Unexpected parameter: '${paramName}'.`,
      error_type: "simple_function_checker:unexpected_param",
    };
  }

  const possibleValues = context.possibleAnswerParams[paramName] as unknown;

  if (typeof modelValue === "string") {
    return checkStringValue(
      paramName,
      modelValue,
      (possibleValues as unknown[] | undefined) ?? []
    );
  }

  if (Array.isArray(modelValue)) {
    return checkArrayValue(paramName, modelValue, possibleValues);
  }

  return checkObjectValue(paramName, modelValue, possibleValues);
}

function checkOptionalParams(
  argsObj: Record<string, unknown>,
  possibleAnswerParams: Record<string, unknown>
): CheckerResult {
  for (const paramName in possibleAnswerParams) {
    if (Object.hasOwn(possibleAnswerParams, paramName)) {
      const val = possibleAnswerParams[paramName] as unknown;
      const isOptional = Array.isArray(val) && val.includes("");
      if (!(paramName in argsObj || isOptional)) {
        return {
          valid: false,
          error: `Missing optional parameter '${paramName}' which was not marked as optional.`,
          error_type: "simple_function_checker:missing_optional",
        };
      }
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
      (f) => f.name === expectedFuncName
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
      if (matchedModelCallIndices.has(i)) {
        continue;
      }

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
    (f) => f.name === expectedFuncName
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
