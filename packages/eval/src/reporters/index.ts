import consoleReporter from "./console";
import jsonReporter from "./json";
import markdownReporter from "./markdown";
import type { BenchmarkResult, AggregatedResult } from "../interfaces";

export type Reporter = {
  result?: (r: BenchmarkResult) => void;
  aggregate?: (a: AggregatedResult) => void;
};

export function getReporter(kind?: string): Reporter | undefined {
  if (!kind) return undefined;
  if (kind === "console") return consoleReporter as unknown as Reporter;
  if (kind === "json") return jsonReporter as unknown as Reporter;
  if (kind === "markdown") return markdownReporter as unknown as Reporter;
  return undefined;
}

export default getReporter;
