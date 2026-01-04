// Execution engine for multi-turn function calls
// Ported from Python's execute_multi_turn_func_call function

import { globalMethodRegistry } from "./method-registry";
import { SafeExecutor } from "./safe-executor";

export interface ExecutionResult {
  executionResults: string[];
  involvedInstances: Record<string, any>;
}

/**
 * Execute a list of function calls and return results + instances
 * This is the core execution engine that replaces Python's eval/importlib system
 */
export async function executeMultiTurnFuncCall(
  funcCallList: string[],
  initialConfig: Record<string, any>,
  involvedClasses: string[],
  modelName: string,
  testEntryId: string,
  longContext = false,
  isEvalRun = false
): Promise<ExecutionResult> {
  // Deep copy initialConfig to avoid state sharing
  const configCopy = JSON.parse(JSON.stringify(initialConfig));
  const classMethodNameMapping: Record<string, string> = {};
  const involvedInstances: Record<string, any> = {};

  // Step 1: Instantiate or retrieve classes
  for (const className of involvedClasses) {
    const instance = globalMethodRegistry.getOrCreateInstance(
      className,
      testEntryId,
      modelName,
      configCopy[className] || {},
      longContext,
      isEvalRun
    );
    involvedInstances[className] = instance;
  }

  // Step 2: Execute function calls
  const executionResults: string[] = [];

  for (const funcCall of funcCallList) {
    try {
      const executionResult = await SafeExecutor.executeFunctionCallSafe(
        funcCall,
        involvedInstances
      );

      if (executionResult.success) {
        // Serialize result
        const result = executionResult.result;
        let serialized: string;

        if (typeof result === "string") {
          serialized = result;
        } else if (result === null || result === undefined) {
          serialized = "None";
        } else if (typeof result === "object") {
          try {
            serialized = JSON.stringify(result);
          } catch {
            serialized = String(result);
          }
        } else {
          serialized = String(result);
        }

        executionResults.push(serialized);
      } else {
        executionResults.push(
          `Error during execution: ${executionResult.error}`
        );
      }
    } catch (error) {
      executionResults.push(
        `Error during execution: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return {
    executionResults,
    involvedInstances,
  };
}

/**
 * Reset instances for a test case (equivalent to Python's globals cleanup)
 */
export function resetInstancesForTest(
  testEntryId: string,
  modelName: string
): void {
  globalMethodRegistry.clearInstancesForTest(testEntryId, modelName);
}

/**
 * Check if a response list is empty (no actual function calls)
 */
export function isEmptyExecuteResponse(responseList: string[]): boolean {
  return responseList.every(
    (response) =>
      response === "" ||
      response === "None" ||
      response === "{}" ||
      response === "[]" ||
      response.includes("Error during execution")
  );
}

/**
 * Process method calls by prepending instance names (for compatibility)
 * In the TypeScript implementation, this is largely handled by the method registry
 */
export function processMethodCalls(
  funcCall: string,
  classMethodNameMapping: Record<string, string>
): string {
  // For now, return as-is since our method registry handles this
  // This function maintains compatibility with the Python implementation
  return funcCall;
}
