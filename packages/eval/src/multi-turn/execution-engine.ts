import { globalMethodRegistry } from "./method-registry";
import { SafeExecutor, type ToolCall } from "./safe-executor";

export interface ExecutionResult {
  executionResults: string[];
  involvedInstances: Record<string, unknown>;
}

export async function executeMultiTurnFuncCall(
  toolCalls: ToolCall[],
  initialConfig: Record<string, unknown>,
  involvedClasses: string[],
  modelName: string,
  testEntryId: string,
  longContext = false,
  isEvalRun = false
): Promise<ExecutionResult> {
  const configCopy = JSON.parse(JSON.stringify(initialConfig));
  const involvedInstances: Record<string, unknown> = {};

  for (const className of involvedClasses) {
    involvedInstances[className] = globalMethodRegistry.getOrCreateInstance(
      className,
      testEntryId,
      modelName,
      configCopy[className] || {},
      longContext,
      isEvalRun
    );
  }

  const results = await SafeExecutor.executeMany(toolCalls, involvedInstances);
  const executionResults = results.map((r) =>
    r.success
      ? SafeExecutor.serializeResult(r.result)
      : `Error during execution: ${r.error}`
  );

  return { executionResults, involvedInstances };
}

export function resetInstancesForTest(
  testEntryId: string,
  modelName: string
): void {
  globalMethodRegistry.clearInstancesForTest(testEntryId, modelName);
}

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
