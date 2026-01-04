// Main checker - orchestrates multi-turn validation
// Ported from Python's multi_turn_checker function

import {
  executeMultiTurnFuncCall,
  isEmptyExecuteResponse,
  resetInstancesForTest,
} from "./execution-engine";
import { responseChecker } from "./response-checker";
import { stateChecker } from "./state-checker";

export interface MultiTurnCheckResult {
  valid: boolean;
  error_type?: string;
  details?: any;
}

/**
 * Main multi-turn checker that orchestrates the entire validation process
 * Ported from Python's multi_turn_checker function
 */
export async function multiTurnChecker(
  multiTurnModelResultListDecoded: string[][][],
  multiTurnGroundTruthList: string[][],
  testEntry: any,
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
  let finalModelInstances: Record<string, any> = initResult.involvedInstances;
  let finalGroundTruthInstances: Record<string, any> =
    initGtResult.involvedInstances;

  for (
    let turnIndex = 0;
    turnIndex < multiTurnGroundTruthList.length;
    turnIndex++
  ) {
    const singleTurnGroundTruthList = multiTurnGroundTruthList[turnIndex];
    const singleTurnModelResponseList =
      multiTurnModelResultListDecoded[turnIndex] || [];

    const singleTurnModelExecutionResults: string[] = [];

    for (const singleStepModelResponse of singleTurnModelResponseList) {
      const stepResult = await executeMultiTurnFuncCall(
        singleStepModelResponse,
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

    const groundTruthExecutionResult = await executeMultiTurnFuncCall(
      singleTurnGroundTruthList,
      initialConfig,
      involvedClasses,
      `${modelName}_ground_truth`,
      testEntry.id,
      testCategory.includes("long_context"),
      true
    );

    allTurnModelExecutionResults.push(...singleTurnModelExecutionResults);
    finalGroundTruthInstances = groundTruthExecutionResult.involvedInstances;

    if (singleTurnGroundTruthList.length === 0) {
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
      groundTruthExecutionResult.executionResults,
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

/**
 * Check if the model's output are irrelevant when it should be
 * Ported from Python's multi_turn_irrelevance_checker
 */
export function multiTurnIrrelevanceChecker(
  multiTurnModelResultListDecoded: string[][][],
  multiTurnGroundTruthList: string[][]
): MultiTurnCheckResult {
  for (
    let turnIndex = 0;
    turnIndex < multiTurnGroundTruthList.length;
    turnIndex++
  ) {
    const singleTurnGroundTruthList = multiTurnGroundTruthList[turnIndex];
    const singleTurnModelResponseList =
      multiTurnModelResultListDecoded[turnIndex] || [];

    // If ground truth is empty, model should also be empty
    if (
      singleTurnGroundTruthList.length === 0 &&
      !isEmptyExecuteResponse(singleTurnModelResponseList.flat())
    ) {
      return {
        valid: false,
        error_type: "multi_turn:irrelevance_error:decoder_success",
        details: { model_response_decoded: singleTurnModelResponseList },
      };
    }
  }

  return { valid: true };
}

/**
 * Reset all instances for a test case
 */
export function resetTestInstances(
  testEntryId: string,
  modelName: string
): void {
  resetInstancesForTest(testEntryId, modelName);
  resetInstancesForTest(testEntryId, `${modelName}_ground_truth`);
}
