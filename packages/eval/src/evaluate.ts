import type { BenchmarkResult, EvaluateOptions } from "./interfaces";
import type { LanguageModel } from "ai";
import { runWithConcurrencySettled, Task } from "./orchestrator";
import { aggregateResults } from "./aggregator";
import { getReporter } from "./reporters";
import fs from "fs";
import path from "path";

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function evaluate(
  options: EvaluateOptions
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  // Build combos from matrix. Support both legacy { models: LanguageModel[] }
  // and PRD-style { model: LanguageModel[], config?: Record<string,unknown>[] }
  let combos: Array<{
    model: LanguageModel;
    config?: Record<string, unknown>;
  }> = [];
  const matrixAny = options.matrix as any;
  if (Array.isArray(matrixAny.models)) {
    combos = matrixAny.models.map((m: LanguageModel) => ({ model: m }));
  } else if (Array.isArray(matrixAny.model)) {
    const models: LanguageModel[] = matrixAny.model;
    const configs: Array<Record<string, unknown>> = Array.isArray(
      matrixAny.config
    )
      ? matrixAny.config
      : [undefined];
    for (const m of models) {
      for (const c of configs) {
        combos.push({ model: m, config: c });
      }
    }
  } else {
    throw new Error(
      "evaluate: options.matrix must contain 'models' or 'model' array"
    );
  }
  const concurrency = options.concurrency ?? 4;
  const retries = options.retries ?? 0;
  const failFast = options.failFast ?? false;
  const backoffBaseMs = options.backoffBaseMs ?? 50;

  const tasks: Task<BenchmarkResult>[] = [];

  for (const combo of combos) {
    for (const bm of options.benchmarks) {
      const task: Task<BenchmarkResult> = async () => {
        let attempt = 0;
        while (true) {
          try {
            const res = await bm.run(combo.model, combo.config);
            if (options.reporter) options.reporter(res);
            // allow options.reporter to be a built-in reporter string
            const built =
              typeof options.reporter === "string"
                ? getReporter(options.reporter)
                : getReporter(options.reporterType);
            if (built?.result) built.result(res);
            return res;
          } catch (err: unknown) {
            attempt++;
            if (attempt > retries) {
              const failRes: BenchmarkResult = {
                score: 0,
                success: false,
                metrics: {},
                logs: [],
                error: String(err),
              };
              if (failFast) throw err;
              return failRes;
            }
            const delay = backoffBaseMs * Math.pow(2, attempt - 1);
            await sleep(delay);
          }
        }
      };
      tasks.push(task);
    }
  }

  const settled = await runWithConcurrencySettled(tasks, { concurrency });

  for (const item of settled) {
    if (item.status === "fulfilled") results.push(item.value);
    else if (failFast) throw item.reason;
    // otherwise, if rejected we already converted to a failure BenchmarkResult where appropriate
  }

  // compute aggregated statistics and call aggregateReporter if provided
  const agg = aggregateResults(results);
  if (options.aggregateReporter) options.aggregateReporter(agg);
  const built = getReporter(options.reporterType);
  if (built?.aggregate) built.aggregate(agg);

  // persist aggregated results to disk if requested
  if (options.persistPath) {
    try {
      const dir = path.dirname(options.persistPath);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(
        options.persistPath,
        JSON.stringify(agg, null, 2),
        "utf8"
      );
    } catch (e) {
      // don't fail the whole evaluation for persistence errors; just log if reporter is present
      if (options.aggregateReporter)
        options.aggregateReporter({
          ...agg,
          metrics: { ...agg.metrics, _persistError: String(e) },
        });
    }
  }

  return results;
}
