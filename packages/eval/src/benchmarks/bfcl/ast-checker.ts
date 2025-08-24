// Local ToolCall interface for type safety, as it's not exported from 'ai'.
export interface ToolCall {
  toolCallId: string;
  toolName: string;
  args: any;
}

// --- Type Definitions ---
interface FunctionDescription {
  name: string;
  description: string;
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
  possibleAnswers: any[]
): { valid: boolean; error?: string; error_type?: string } {
  const standardizedModelValue = standardizeString(modelValue);
  const standardizedPossibleAnswers = possibleAnswers.map(ans =>
    standardizeString(ans)
  );

  if (!standardizedPossibleAnswers.includes(standardizedModelValue)) {
    return {
      valid: false,
      error: `Invalid value for parameter '${param}': '${modelValue}'. Expected one of ${possibleAnswers.join(", ")}.`,
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
  possibleAnswer: Record<string, any>
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

  const possibleAnswerParams = possibleAnswer[Object.keys(possibleAnswer)[0]];

  for (const param of requiredParams) {
    if (!(param in modelArgs)) {
      return {
        valid: false,
        error: `Missing required parameter: '${param}'.`,
        error_type: "simple_function_checker:missing_required",
      };
    }
  }

  for (const paramName in modelArgs) {
    const modelValue = modelArgs[paramName];
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

    const possibleValues = possibleAnswerParams[paramName];

    if (typeof modelValue === "string") {
      const result = checkStringValue(paramName, modelValue, possibleValues);
      if (!result.valid) return result;
    } else if (Array.isArray(modelValue)) {
      const modelValueStr = JSON.stringify(
        modelValue.map(v => standardizeString(v.toString())).sort()
      );
      const hasMatch = possibleValues.some(
        (p: any) =>
          JSON.stringify(
            p.map((v: any) => standardizeString(v.toString())).sort()
          ) === modelValueStr
      );
      if (!hasMatch) {
        return {
          valid: false,
          error: `Invalid value for list parameter '${paramName}'.`,
          error_type: "value_error:list",
        };
      }
    } else {
      if (!possibleValues.includes(modelValue)) {
        return {
          valid: false,
          error: `Invalid value for parameter '${paramName}': got '${modelValue}', expected one of '${possibleValues}'.`,
          error_type: "value_error:other",
        };
      }
    }
  }

  for (const paramName in possibleAnswerParams) {
    if (
      !(paramName in modelArgs) &&
      !possibleAnswerParams[paramName].includes("")
    ) {
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
  possibleAnswers: Record<string, any>[]
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
  possibleAnswers: Record<string, any>[]
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
