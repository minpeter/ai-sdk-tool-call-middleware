import { EvaluationResult } from "../interfaces";

export function jsonReporter(results: EvaluationResult[]): void {
  // Output the raw results array as a JSON string.
  // The 'error' object is converted to a string for serialization.
  const serializableResults = results.map(r => ({
    ...r,
    result: {
      ...r.result,
      error: r.result.error?.message,
    },
  }));
  console.log(JSON.stringify(serializableResults, null, 2));
}
