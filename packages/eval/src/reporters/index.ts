import type { EvaluationResult, ReporterType } from "@/interfaces";

import { consoleReporter } from "./console";
import { consoleDebugReporter } from "./console.debug";
import { jsonReporter } from "./json";

export const reporters: Record<
  ReporterType,
  (results: EvaluationResult[]) => void
> = {
  console: consoleReporter,
  json: jsonReporter,
  "console.debug": consoleDebugReporter,
};
