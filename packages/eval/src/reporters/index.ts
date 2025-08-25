import { EvaluationResult, ReporterType } from "../interfaces";
import { consoleReporter } from "./console";
import { jsonReporter } from "./json";

export const reporters: Record<
  ReporterType,
  (results: EvaluationResult[]) => void
> = {
  console: consoleReporter,
  json: jsonReporter,
};
