import type { EvaluationResult } from "../interfaces";

/**
 * A reporter that does nothing - useful when you want to run evaluations silently.
 */
export const noneReporter = (_results: EvaluationResult[]): void => {
  // Do nothing - no output
};
