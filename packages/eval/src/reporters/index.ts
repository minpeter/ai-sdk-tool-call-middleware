import { EvaluationResult, ReporterType } from "../interfaces";
import { consoleReporter } from "./console";
import { jsonReporter } from "./json";
import { highlightReporter } from "./highlight";

export const reporters: Record<
  ReporterType,
  (results: EvaluationResult[]) => void
> = {
  console: consoleReporter,
  json: jsonReporter,
  // 'highlight' is a specialized reporter that emphasizes failed BFCL cases
  // Note: Type system currently lists ReporterType as "console" | "json";
  // The evaluate options accept only those values. To use 'highlight', callers
  // can directly import and call the reporter function, or we can extend the
  // ReporterType in a follow-up edit.
  // For now, keep it available here under a dynamic key to avoid type issues.
  // @ts-ignore: dynamic reporter addition
  highlight: highlightReporter,
};
