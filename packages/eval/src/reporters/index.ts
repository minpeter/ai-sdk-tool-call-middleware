import type { EvaluationResult, ReporterType } from "../interfaces";

import { consoleReporter } from "./console";
import { consoleDebugReporter } from "./console.debug";
import { consoleSummaryReporter } from "./console.summary";
import { jsonReporter } from "./json";
import { noneReporter } from "./none";

export const reporters: Record<
  ReporterType,
  (results: EvaluationResult[]) => void
> = {
  console: consoleReporter,
  json: jsonReporter,
  "console.debug": consoleDebugReporter,
  "console.summary": consoleSummaryReporter,
  none: noneReporter,
};
