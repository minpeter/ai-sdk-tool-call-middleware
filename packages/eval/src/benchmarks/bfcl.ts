import type { LanguageModelV2Benchmark, BenchmarkResult } from "../interfaces";
import type { LanguageModel } from "ai";
import fs from "fs";
import path from "path";
import { loadLocalDataset } from "../data/bfcl/loader";

type BfclExample = {
  id: string;
  question: Array<Array<{ role: string; content: string }>>;
  function: Array<{
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
};

export const bfclBenchmark: LanguageModelV2Benchmark = {
  name: "bfcl",
  version: "0.2.0",
  description: "BFCL v3 simple evaluator (API mode)",
  async run(model?: LanguageModel, config?: Record<string, unknown>) {
    try {
      // primary: use dataset/possibleAnswers passed explicitly via config
      let dataset = (config && (config.dataset as BfclExample[])) || [];
      let possibleAnswers: Record<
        string,
        Array<Record<string, unknown>>
      > = (config &&
        (config.possibleAnswers as Record<
          string,
          Array<Record<string, unknown>>
        >)) ||
      {};

      // fallback: try to load dataset from known example files when not provided
      if (!dataset || dataset.length === 0) {
        const candidates = [
          (config && (config.datasetPath as string)) || undefined,
          // when running from repo root
          path.join(
            process.cwd(),
            "examples",
            "eval",
            "data",
            "bfcl",
            "BFCL_v3_simple.json"
          ),
          // when running from examples/eval (cwd === examples/eval)
          path.join(process.cwd(), "data", "bfcl", "BFCL_v3_simple.json"),
          // try parent paths (in case of different working dir)
          path.join(
            process.cwd(),
            "..",
            "examples",
            "eval",
            "data",
            "bfcl",
            "BFCL_v3_simple.json"
          ),
          // legacy sample name
          path.join(
            process.cwd(),
            "examples",
            "eval",
            "data",
            "bfcl",
            "sample.json"
          ),
          // package-local data (when running from package source or installed package)
          path.join(
            __dirname,
            "..",
            "..",
            "data",
            "bfcl",
            "BFCL_v3_simple.jsonl"
          ),
          path.join(
            __dirname,
            "..",
            "..",
            "data",
            "bfcl",
            "BFCL_v3_simple.json"
          ),
        ].filter(Boolean) as string[];
        for (const p of candidates) {
          try {
            // debug: log candidate path
            console.log(`bfcl: trying dataset candidate: ${p}`);
            const ds = loadLocalDataset(p);
            if (Array.isArray(ds) && ds.length > 0) {
              dataset = ds as BfclExample[];
              break;
            }
          } catch {
            // debug: log error
            console.log(`bfcl: candidate ${p} failed`);
            // try next
          }
        }
      }

      // fallback for possible answers: try known possible-answers files (JSONL or JSON)
      if (!possibleAnswers || Object.keys(possibleAnswers).length === 0) {
        const paCandidates = [
          (config && (config.possibleAnswersPath as string)) || undefined,
          path.join(
            process.cwd(),
            "examples",
            "eval",
            "data",
            "bfcl",
            "BFCL_v3_simple_possible_answers.json"
          ),
          path.join(
            process.cwd(),
            "data",
            "bfcl",
            "BFCL_v3_simple_possible_answers.json"
          ),
          path.join(
            process.cwd(),
            "..",
            "examples",
            "eval",
            "data",
            "bfcl",
            "BFCL_v3_simple_possible_answers.json"
          ),
          path.join(
            process.cwd(),
            "examples",
            "eval",
            "data",
            "bfcl",
            "BFCL_v3_simple_possible_answers.jsonl"
          ),
          // package-local possible-answers JSONL
          path.join(
            __dirname,
            "..",
            "..",
            "data",
            "bfcl",
            "BFCL_v3_simple_possible_answers.jsonl"
          ),
          path.join(
            __dirname,
            "..",
            "..",
            "data",
            "bfcl",
            "BFCL_v3_simple_possible_answers.json"
          ),
        ].filter(Boolean) as string[];
        for (const p of paCandidates) {
          try {
            const raw = fs.readFileSync(p, "utf8");
            const rows = raw
              .split(/\r?\n/)
              .map(l => l.trim())
              .filter(Boolean);
            for (const r of rows) {
              try {
                const obj = JSON.parse(r) as {
                  id?: string;
                  ground_truth?: unknown[];
                };
                if (obj?.id && Array.isArray(obj.ground_truth)) {
                  possibleAnswers[obj.id] = obj.ground_truth as Array<
                    Record<string, unknown>
                  >;
                }
              } catch {
                // ignore malformed lines
              }
            }
            if (Object.keys(possibleAnswers).length > 0) break;
          } catch {
            // try next
          }
        }
      }
      const logs: string[] = [];
      let correct = 0;

      if (!dataset || dataset.length === 0) {
        return {
          score: 0,
          success: false,
          metrics: {},
          logs: ["No BFCL dataset provided in config.dataset"],
        };
      }

      if (!model) {
        return {
          score: 0,
          success: false,
          metrics: {},
          logs: ["No LanguageModel provided to benchmark.run"],
        };
      }

      for (const ex of dataset) {
        try {
          const messages = ex.question
            .flat()
            .map(m => ({ role: m.role, content: m.content }));

          const input = {
            messages,
            functions: ex.function,
          };

          // call model
          let raw: unknown;
          try {
            const caller = model as unknown as {
              call?: (i: unknown) => Promise<unknown>;
            };
            if (!caller.call)
              throw new Error("model does not implement call()");
            raw = await caller.call(input);
          } catch (e) {
            logs.push(
              `model.call failed for ${ex.id}: ${(e as Error)?.message ?? String(e)}`
            );
            continue;
          }

          // normalize output
          let predicted: { function?: string; args?: Record<string, unknown> } =
            {};

          const tryParseJsonString = (s: string) => {
            try {
              return JSON.parse(s) as unknown;
            } catch {
              return undefined;
            }
          };

          if (typeof raw === "string") {
            const parsed = tryParseJsonString(raw);
            if (parsed && typeof parsed === "object") {
              predicted = parsed as {
                function?: string;
                args?: Record<string, unknown>;
              };
            } else {
              const m = (raw as string).match(/\{[\s\S]*\}/);
              if (m && m[0]) {
                const parsed2 = tryParseJsonString(m[0]);
                if (parsed2 && typeof parsed2 === "object") {
                  predicted = parsed2 as {
                    function?: string;
                    args?: Record<string, unknown>;
                  };
                } else {
                  logs.push(
                    `unable to parse JSON from model string output for ${ex.id}`
                  );
                }
              }
            }
          } else if (raw && typeof raw === "object") {
            const obj = raw as Record<string, unknown>;
            if (typeof obj.function === "string") {
              predicted.function = obj.function as string;
              predicted.args =
                (obj.args as Record<string, unknown>) ?? undefined;
            } else if (
              obj.function_call &&
              typeof obj.function_call === "object"
            ) {
              const fc = obj.function_call as Record<string, unknown>;
              if (typeof fc.name === "string")
                predicted.function = fc.name as string;
              if (typeof fc.arguments === "string") {
                const parsedArgs = tryParseJsonString(fc.arguments as string);
                if (parsedArgs && typeof parsedArgs === "object")
                  predicted.args = parsedArgs as Record<string, unknown>;
              } else if (typeof fc.arguments === "object") {
                predicted.args = fc.arguments as Record<string, unknown>;
              }
            } else if (
              Array.isArray(obj.choices) &&
              (obj.choices as unknown[]).length > 0
            ) {
              const first = (obj.choices as unknown[])[0] as
                | Record<string, unknown>
                | undefined;
              const msg = first?.message as Record<string, unknown> | undefined;
              if (msg?.function_call && typeof msg.function_call === "object") {
                const fc = msg.function_call as Record<string, unknown>;
                if (typeof fc.name === "string")
                  predicted.function = fc.name as string;
                if (typeof fc.arguments === "string") {
                  const parsedArgs = tryParseJsonString(fc.arguments as string);
                  if (parsedArgs && typeof parsedArgs === "object")
                    predicted.args = parsedArgs as Record<string, unknown>;
                } else if (typeof fc.arguments === "object") {
                  predicted.args = fc.arguments as Record<string, unknown>;
                }
              }
            }
          }

          const ground = possibleAnswers[ex.id];
          let matched = false;
          if (ground && Array.isArray(ground)) {
            for (const g of ground) {
              const candidate = g as Record<string, unknown>;
              const keys = Object.keys(candidate);
              if (keys.length === 0) continue;
              const fname = keys[0];
              const expectedArgs = candidate[fname] as
                | Record<string, unknown>
                | undefined;

              if (predicted.function === fname) {
                const pArgs = predicted.args || {};
                let ok = true;
                if (expectedArgs) {
                  for (const k of Object.keys(expectedArgs)) {
                    if (!(k in pArgs)) {
                      ok = false;
                      break;
                    }
                  }
                } else {
                  ok = false;
                }
                if (ok) {
                  matched = true;
                  break;
                }
              }
            }
          }

          logs.push(
            `ex=${ex.id} predicted=${JSON.stringify(predicted)} matched=${matched}`
          );
          if (matched) correct++;
        } catch (inner) {
          logs.push(`error evaluating ${ex.id}: ${(inner as Error).message}`);
        }
      }

      const total = dataset.length;
      const score = total === 0 ? 0 : correct / total;
      return {
        score,
        success: true,
        metrics: { total, correct },
        logs,
      } as BenchmarkResult;
    } catch (err) {
      return {
        score: 0,
        success: false,
        metrics: {},
        logs: [],
        error: (err as Error).message,
      };
    }
  },
};
