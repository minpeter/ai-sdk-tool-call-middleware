import { EvaluationResult, ReporterType } from "../interfaces.js";
import { consoleReporter } from "./console.js";
import { jsonReporter } from "./json.js";

export const reporters: Record<
  ReporterType,
  (results: EvaluationResult[]) => void
> = {
  console: consoleReporter,
  json: jsonReporter,
};
