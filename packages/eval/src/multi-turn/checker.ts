import {
  executeMultiTurnFuncCall,
  isEmptyExecuteResponse,
  resetInstancesForTest,
} from "./execution-engine";
import { responseChecker } from "./response-checker";
import { SafeExecutor, type ToolCall } from "./safe-executor";
import { stateChecker } from "./state-checker";

export interface MultiTurnCheckResult {
  valid: boolean;
  error_type?: string;
  details?: unknown;
}

function parseGroundTruth(pythonCalls: string[]): ToolCall[] {
  return pythonCalls.map((call) => SafeExecutor.parsePythonCall(call));
}

export async function multiTurnChecker(
  modelToolCalls: ToolCall[][][],
  groundTruthPythonCalls: string[][],
  testEntry: {
    id: string;
    initial_config?: Record<string, unknown>;
    involved_classes?: string[];
  },
  testCategory: string,
  modelName: string
): Promise<MultiTurnCheckResult> {
  const initialConfig = testEntry.initial_config || {};
  const involvedClasses = testEntry.involved_classes || [];

  resetInstancesForTest(testEntry.id, modelName);
  resetInstancesForTest(testEntry.id, `${modelName}_ground_truth`);

  const initResult = await executeMultiTurnFuncCall(
    [],
    initialConfig,
    involvedClasses,
    modelName,
    testEntry.id,
    testCategory.includes("long_context"),
    true
  );
  const initGtResult = await executeMultiTurnFuncCall(
    [],
    initialConfig,
    involvedClasses,
    `${modelName}_ground_truth`,
    testEntry.id,
    testCategory.includes("long_context"),
    true
  );

  const allTurnModelExecutionResults: string[] = [];
  let finalModelInstances = initResult.involvedInstances;
  let finalGroundTruthInstances = initGtResult.involvedInstances;

  for (
    let turnIndex = 0;
    turnIndex < groundTruthPythonCalls.length;
    turnIndex++
  ) {
    const groundTruthCalls = parseGroundTruth(
      groundTruthPythonCalls[turnIndex]
    );
    const modelSteps = modelToolCalls[turnIndex] || [];

    const singleTurnModelExecutionResults: string[] = [];

    for (const stepToolCalls of modelSteps) {
      const stepResult = await executeMultiTurnFuncCall(
        stepToolCalls,
        initialConfig,
        involvedClasses,
        modelName,
        testEntry.id,
        testCategory.includes("long_context"),
        true
      );
      singleTurnModelExecutionResults.push(...stepResult.executionResults);
      finalModelInstances = stepResult.involvedInstances;
    }

    const groundTruthResult = await executeMultiTurnFuncCall(
      groundTruthCalls,
      initialConfig,
      involvedClasses,
      `${modelName}_ground_truth`,
      testEntry.id,
      testCategory.includes("long_context"),
      true
    );

    allTurnModelExecutionResults.push(...singleTurnModelExecutionResults);
    finalGroundTruthInstances = groundTruthResult.involvedInstances;

    if (groundTruthCalls.length === 0) {
      continue;
    }

    const stateCheckResult = stateChecker(
      finalModelInstances,
      finalGroundTruthInstances
    );
    if (!stateCheckResult.valid) {
      return {
        valid: false,
        error_type: stateCheckResult.error_type,
        details: stateCheckResult.details,
      };
    }

    const responseCheckResult = responseChecker(
      allTurnModelExecutionResults,
      groundTruthResult.executionResults,
      turnIndex
    );
    if (!responseCheckResult.valid) {
      return {
        valid: false,
        error_type: responseCheckResult.error_type,
        details: responseCheckResult.details,
      };
    }
  }

  return { valid: true };
}

export function multiTurnIrrelevanceChecker(
  modelToolCalls: ToolCall[][][],
  groundTruthPythonCalls: string[][]
): MultiTurnCheckResult {
  for (
    let turnIndex = 0;
    turnIndex < groundTruthPythonCalls.length;
    turnIndex++
  ) {
    const groundTruthCalls = groundTruthPythonCalls[turnIndex];
    const modelSteps = modelToolCalls[turnIndex] || [];

    const flatModelCalls = modelSteps.flat();
    const modelCallStrings = flatModelCalls.map((tc) =>
      tc.args ? JSON.stringify(tc) : "None"
    );

    if (
      groundTruthCalls.length === 0 &&
      !isEmptyExecuteResponse(modelCallStrings)
    ) {
      return {
        valid: false,
        error_type: "multi_turn:irrelevance_error:decoder_success",
        details: { model_response_decoded: modelSteps },
      };
    }
  }

  return { valid: true };
}

export function resetTestInstances(
  testEntryId: string,
  modelName: string
): void {
  resetInstancesForTest(testEntryId, modelName);
  resetInstancesForTest(testEntryId, `${modelName}_ground_truth`);
}
