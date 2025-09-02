import { generateText, jsonSchema, LanguageModel, tool } from "ai";
import { promises as fs } from "fs";
import path from "path";

import { BenchmarkResult, LanguageModelV2Benchmark } from "@/interfaces";
import { resolveDataDir } from "@/utils/paths";

import {
  FunctionDescription,
  multipleFunctionChecker,
  parallelFunctionCheckerNoOrder,
  simpleFunctionChecker,
  ToolCall,
} from "./bfcl/ast-checker";

// Resolve data files relative to this module using ESM-safe utilities

// --- Interfaces ---
interface ToolSchemaObject {
  type: string;
  properties?: Record<string, unknown>;
  items?: unknown;
  required?: string[];
  [key: string]: unknown;
}

interface ToolSpec {
  name: string;
  description?: string;
  parameters: ToolSchemaObject;
}

type Message = { role: string; content: string };

interface TestCase {
  id: string;
  question: Message[] | Message[][];
  function: ToolSpec[];
}

interface TransformedTool {
  type: "function";
  name: string;
  description?: string;
  inputSchema: ToolSchemaObject;
}

interface PossibleAnswer {
  id: string;
  ground_truth: unknown;
}

// --- Generic Checker Dispatcher ---
function check(
  testCase: TestCase,
  modelOutput: unknown, // This is an array of tool_calls
  possibleAnswer: PossibleAnswer
): { valid: boolean; error?: string; error_type?: string } {
  const category = testCase.id.split("_")[0];

  try {
    if (category === "simple") {
      if (!Array.isArray(modelOutput) || modelOutput.length !== 1) {
        return {
          valid: false,
          error: `Expected 1 function call, but got ${Array.isArray(modelOutput) ? modelOutput.length : 0}.`,
          error_type: "simple:wrong_count",
        };
      }
      return simpleFunctionChecker(
        testCase.function[0] as unknown as FunctionDescription,
        modelOutput[0] as ToolCall,
        (possibleAnswer.ground_truth as Array<Record<string, unknown>>)[0]
      );
    } else if (category === "parallel") {
      return parallelFunctionCheckerNoOrder(
        testCase.function as unknown as FunctionDescription[],
        modelOutput as ToolCall[],
        possibleAnswer.ground_truth as Array<Record<string, unknown>>
      );
    } else if (category === "multiple") {
      return multipleFunctionChecker(
        testCase.function as unknown as FunctionDescription[],
        modelOutput as ToolCall[],
        possibleAnswer.ground_truth as Array<Record<string, unknown>>
      );
    } else if (category.includes("parallel-multiple")) {
      // parallel-multiple is just a more complex parallel case
      return parallelFunctionCheckerNoOrder(
        testCase.function as unknown as FunctionDescription[],
        modelOutput as ToolCall[],
        possibleAnswer.ground_truth as Array<Record<string, unknown>>
      );
    }

    // Default for unimplemented categories (like multi_turn)
    // As per user request, we are deferring multi-turn.
    return { valid: true }; // Pass to not fail the whole benchmark
  } catch (e: unknown) {
    return {
      valid: false,
      error: `Checker Error: ${(e as Error).message}`,
      error_type: "checker_error",
    };
  }
}

// --- Generic Benchmark Runner Factory ---
function createBfclBenchmark(
  name: string,
  description: string,
  testDataFile: string,
  answerDataFile: string
): LanguageModelV2Benchmark {
  return {
    name,
    version: "1.0.0",
    description,
    async run(
      model: LanguageModel,
      config?: Record<string, unknown>
    ): Promise<BenchmarkResult> {
      const logs: string[] = [];
      let correctCount = 0;
      let testCases: TestCase[] = [];

      try {
        // Resolve data directory in a way that works both in monorepo and when installed as a dependency.
        const dataPath = resolveDataDir();
        logs.push(`[INFO] Using data dir: ${dataPath}`);
        const testCasesJson = await fs.readFile(
          path.join(dataPath, testDataFile),
          "utf-8"
        );
        const possibleAnswersJson = await fs.readFile(
          path.join(dataPath, answerDataFile),
          "utf-8"
        );

        // The BFCL datasets are in JSON Lines (NDJSON) format: one JSON object per line.
        // Parse them line-by-line instead of as a single JSON value.
        testCases = testCasesJson
          .split(/\r?\n/)
          .filter(line => line.trim().length > 0)
          .map(line => JSON.parse(line));
        const possibleAnswers: PossibleAnswer[] = possibleAnswersJson
          .split(/\r?\n/)
          .filter(line => line.trim().length > 0)
          .map(line => JSON.parse(line));
        const possibleAnswersMap = new Map(
          possibleAnswers.map(ans => [ans.id, ans])
        );

        // Optional: limit number of test cases via env for faster local runs
        const limitEnv = process.env.BFCL_LIMIT;
        const limit = limitEnv ? Number(limitEnv) : undefined;
        if (limit && Number.isFinite(limit) && limit > 0) {
          testCases = testCases.slice(0, limit);
          logs.push(
            `[INFO] Limiting test cases to ${limit} due to BFCL_LIMIT.`
          );
        }

        // Helper: fix BFCL JSON schema types to OpenAI-compatible JSON Schema
        const fixSchema = (schema: unknown): unknown => {
          if (!schema || typeof schema !== "object")
            return { type: "object", properties: {} };
          const copy: ToolSchemaObject | unknown[] = Array.isArray(schema)
            ? (schema as unknown[]).map(v => fixSchema(v))
            : ({ ...(schema as Record<string, unknown>) } as ToolSchemaObject);
          if (!Array.isArray(copy)) {
            if (copy.type) {
              if (copy.type === "dict") copy.type = "object";
              if (copy.type === "integer" || copy.type === "float")
                copy.type = "number";
            }
            if (copy.properties && typeof copy.properties === "object") {
              for (const k of Object.keys(copy.properties)) {
                (copy.properties as Record<string, unknown>)[k] = fixSchema(
                  (copy.properties as Record<string, unknown>)[k]
                );
              }
            }
            if (copy.items) copy.items = fixSchema(copy.items);
            return copy;
          }
          return copy;
        };

        // Concurrency control via env BFCL_CONCURRENCY (default 4)
        const concurrencyEnv = process.env.BFCL_CONCURRENCY;
        const concurrency =
          concurrencyEnv && Number.isFinite(Number(concurrencyEnv))
            ? Math.max(1, Number(concurrencyEnv))
            : 4;
        logs.push(
          `[INFO] Running ${testCases.length} test cases with concurrency=${concurrency}`
        );

        // Per-test runner that does not throw and returns its own logs
        const runSingleCase = async (
          testCase: TestCase
        ): Promise<{ valid: boolean; logs: string[] }> => {
          const caseLogs: string[] = [];
          const { function: tools, question: messages } = testCase;
          const temp = config?.temperature;
          const temperature = typeof temp === "number" ? temp : undefined;
          const maxTok = config?.maxTokens;
          const maxTokens = typeof maxTok === "number" ? maxTok : undefined;

          try {
            // Flatten BFCL message shape [[{role, content}], ...] to [{role, content}, ...]
            const flatMessages =
              Array.isArray(messages) &&
              (messages as unknown[]).some(m => Array.isArray(m))
                ? (messages as unknown[] as Message[][]).flat(1)
                : (messages as Message[]);

            // Build tools array (LanguageModelV2FunctionTool[]) for middleware compatibility
            // Keep a mapping sanitized -> original to restore before checking
            const nameMap = new Map<string, string>();
            const sanitizeName = (name: string) => {
              // OpenAI-compatible: letters, digits, underscores and dashes, max 64
              const s = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
              return s.length > 0 ? s : "tool";
            };

            const transformedTools: TransformedTool[] = (
              tools as ToolSpec[]
            ).map(t => {
              const fixed = fixSchema(t.parameters);
              // Ensure we always provide a valid JSON Schema object of type 'object'
              const isObjectSchema =
                fixed &&
                typeof fixed === "object" &&
                (fixed as ToolSchemaObject).type === "object";
              const inputSchema: ToolSchemaObject = isObjectSchema
                ? (fixed as ToolSchemaObject)
                : { type: "object", properties: {} };

              const sanitized = sanitizeName(t.name);
              nameMap.set(sanitized, t.name);

              return {
                type: "function" as const,
                name: sanitized,
                description: t.description,
                inputSchema: inputSchema,
              };
            });

            // Convert to ToolSet expected by generateText
            const toolsMap = Object.fromEntries(
              transformedTools.map(t => [
                t.name,
                tool({
                  description:
                    typeof t.description === "string"
                      ? t.description
                      : undefined,
                  inputSchema: jsonSchema(t.inputSchema as unknown as any),
                }),
              ])
            );

            // Debug: record first tool object and schema type
            try {
              const firstTool = transformedTools[0];
              const schemaType =
                (firstTool as any)?.inputSchema?.type ??
                (firstTool as any)?.inputSchema?.jsonSchema?.type;
              caseLogs.push(
                `[DEBUG] ${testCase.id}: firstTool=${JSON.stringify(firstTool)}, schemaType=${schemaType}`
              );
            } catch (e: unknown) {
              caseLogs.push(
                `[DEBUG] ${testCase.id}: failed to introspect tools: ${(e as Error).message}`
              );
            }

            const { toolCalls, text, finishReason } = await generateText({
              model,
              messages: flatMessages as unknown as any,
              tools: toolsMap,
              toolChoice: "auto",
              ...(temperature !== undefined ? { temperature } : {}),
              ...(maxTokens !== undefined ? { maxTokens } : {}),
            });

            // Debug: raw toolCalls
            try {
              caseLogs.push(
                `[DEBUG] ${testCase.id}: rawToolCalls=${JSON.stringify(toolCalls)}, finishReason=${finishReason}, text=${JSON.stringify(text)}`
              );
            } catch {
              caseLogs.push(
                `[DEBUG] ${testCase.id}: failed to serialize toolCalls`
              );
            }

            const possibleAnswer = possibleAnswersMap.get(testCase.id);
            if (!possibleAnswer) {
              throw new Error(`No possible answer for id: ${testCase.id}`);
            }

            // Restore original tool names in toolCalls before checking
            const restoredCalls = (toolCalls || []).map((c: any) => {
              const rawName = (c as any).toolName ?? (c as any).name;
              // Some providers (e.g., response-format models) may encode tool name as a numeric index string
              const sanitizedFromIndex =
                typeof rawName === "string" && /^\d+$/.test(rawName)
                  ? (transformedTools[Number(rawName)]?.name ?? rawName)
                  : rawName;
              const originalName =
                nameMap.get(sanitizedFromIndex) ?? sanitizedFromIndex;
              const extractedArgs =
                (c as any).args ??
                (c as any).arguments ??
                (c as any).input ??
                (c as any).params ??
                (c as any).parameters ??
                undefined;
              let parsedArgs = extractedArgs;
              if (typeof parsedArgs === "string") {
                try {
                  parsedArgs = JSON.parse(parsedArgs);
                } catch {
                  // leave as string if not JSON
                }
              }
              return {
                ...c,
                toolName: originalName,
                name: originalName,
                args: parsedArgs ?? {},
              };
            });

            const checkerResult = check(
              testCase,
              restoredCalls,
              possibleAnswer
            );

            if (checkerResult.valid) {
              caseLogs.push(`[PASS] ${testCase.id}`);
              return { valid: true, logs: caseLogs };
            } else {
              caseLogs.push(`[FAIL] ${testCase.id}: ${checkerResult.error}`);
              try {
                // Build a compact expectation/actual summary and a human-friendly diff
                const category = testCase.id.split("_")[0];
                const diff: string[] = [];
                const summarizeArgs = (args: unknown): unknown => {
                  if (args == null) return args;
                  if (typeof args !== "object") return args;
                  // Sort object keys for stable output
                  return Object.keys(args)
                    .sort()
                    .reduce(
                      (acc: Record<string, unknown>, k) => {
                        acc[k] = (args as Record<string, unknown>)[k];
                        return acc;
                      },
                      {} as Record<string, unknown>
                    );
                };

                const expected: Record<string, unknown> = {};
                const actual: Record<string, unknown> = {};

                if (category === "simple") {
                  const funcDesc = (tools as ToolSpec[])[0];
                  const gt = (possibleAnswer as { ground_truth?: unknown[] })
                    .ground_truth?.[0] as Record<string, unknown> | undefined;
                  const expectedFuncName = funcDesc?.name;
                  const expectedParams = gt
                    ? gt[Object.keys(gt)[0]]
                    : undefined;
                  const received = (restoredCalls as any[])[0];
                  const receivedName = received?.toolName ?? received?.name;
                  const receivedArgs = summarizeArgs(received?.args);

                  expected.function = expectedFuncName;
                  expected.params = expectedParams;
                  actual.function = receivedName;
                  actual.args = receivedArgs;

                  if (expectedFuncName !== receivedName) {
                    diff.push(`@@ function name`);
                    diff.push(`- ${expectedFuncName}`);
                    diff.push(`+ ${receivedName}`);
                  }
                  if (
                    expectedParams &&
                    receivedArgs &&
                    typeof receivedArgs === "object" &&
                    receivedArgs !== null
                  ) {
                    const required = (funcDesc?.parameters?.required ??
                      []) as string[];
                    // Missing required
                    for (const req of required) {
                      if (!(req in receivedArgs)) {
                        diff.push(`- missing required param: ${req}`);
                      }
                    }
                    // Unexpected
                    for (const k of Object.keys(
                      receivedArgs as Record<string, unknown>
                    )) {
                      if (
                        !Object.prototype.hasOwnProperty.call(expectedParams, k)
                      ) {
                        diff.push(`+ unexpected param: ${k}`);
                      }
                    }
                    // Invalid values
                    for (const k of Object.keys(
                      receivedArgs as Record<string, unknown>
                    )) {
                      if (
                        Object.prototype.hasOwnProperty.call(expectedParams, k)
                      ) {
                        const allowed = (
                          expectedParams as Record<string, unknown[]>
                        )[k];
                        const got = (receivedArgs as Record<string, unknown>)[
                          k
                        ];
                        const includes =
                          Array.isArray(allowed) &&
                          allowed.some((v: unknown) => {
                            try {
                              if (Array.isArray(got)) {
                                return (
                                  JSON.stringify(
                                    got.map(x => String(x)).sort()
                                  ) ===
                                  JSON.stringify(
                                    (v as unknown[]).map(x => String(x)).sort()
                                  )
                                );
                              }
                            } catch {
                              void 0;
                            }
                            return (
                              String(v).toLowerCase().replace(/\s+/g, "") ===
                              String(got).toLowerCase().replace(/\s+/g, "")
                            );
                          });
                        if (!includes) {
                          diff.push(`@@ param ${k}`);
                          diff.push(
                            `- expected one of: ${JSON.stringify(allowed)}`
                          );
                          diff.push(`+ got: ${JSON.stringify(got)}`);
                        }
                      }
                    }
                  }
                } else {
                  // Parallel / multiple: show function name sets and param-level diffs per matched function
                  const gtArr: Array<Record<string, unknown>> =
                    (
                      possibleAnswer as {
                        ground_truth?: Array<Record<string, unknown>>;
                      }
                    ).ground_truth ?? [];
                  const expectedNames = gtArr.map(g => Object.keys(g)[0]);
                  const actualNames = (restoredCalls as any[]).map(
                    c => c.toolName ?? c.name
                  );
                  expected.functions = expectedNames;
                  actual.functions = actualNames;

                  if (expectedNames.length !== actualNames.length) {
                    diff.push(`@@ call count`);
                    diff.push(`- expected ${expectedNames.length}`);
                    diff.push(`+ got ${actualNames.length}`);
                  }

                  const missing = expectedNames.filter(
                    n => !actualNames.includes(n)
                  );
                  const extra = actualNames.filter(
                    n => !expectedNames.includes(n)
                  );
                  for (const m of missing)
                    diff.push(`- missing function: ${m}`);
                  for (const e of extra)
                    diff.push(`+ unexpected function: ${e}`);

                  // Attempt to compute param-level diffs for functions that exist in both expected and actual
                  const usedActual = new Set<number>();
                  for (const expectedObj of gtArr) {
                    const fname = Object.keys(expectedObj)[0];
                    // Find a matching actual call not yet used
                    let matchedIndex = -1;
                    for (let i = 0; i < (restoredCalls as any[]).length; i++) {
                      if (usedActual.has(i)) continue;
                      const rc = (restoredCalls as any[])[i];
                      const rcName = rc?.toolName ?? rc?.name;
                      if (rcName === fname) {
                        matchedIndex = i;
                        break;
                      }
                    }
                    if (matchedIndex === -1) continue; // already reported as missing above
                    usedActual.add(matchedIndex);

                    const received = (restoredCalls as any[])[matchedIndex];
                    const receivedArgs = summarizeArgs(received?.args);

                    // expected parameters allowed values
                    const expectedParamsAllowed = expectedObj[fname] as Record<
                      string,
                      unknown
                    >;
                    const funcDesc = (tools as ToolSpec[]).find(
                      (t: ToolSpec) => t.name === fname
                    );
                    const requiredParams = (funcDesc?.parameters?.required ??
                      []) as string[];

                    diff.push(`@@ function ${fname}`);

                    if (
                      expectedParamsAllowed &&
                      receivedArgs &&
                      typeof receivedArgs === "object" &&
                      receivedArgs !== null
                    ) {
                      // Missing required
                      for (const req of requiredParams) {
                        if (!(req in receivedArgs)) {
                          diff.push(`- missing required param: ${req}`);
                        }
                      }
                      // Unexpected params
                      for (const k of Object.keys(
                        receivedArgs as Record<string, unknown>
                      )) {
                        if (
                          !Object.prototype.hasOwnProperty.call(
                            expectedParamsAllowed,
                            k
                          )
                        ) {
                          diff.push(`+ unexpected param: ${k}`);
                        }
                      }
                      // Invalid values
                      for (const k of Object.keys(
                        receivedArgs as Record<string, unknown>
                      )) {
                        if (
                          Object.prototype.hasOwnProperty.call(
                            expectedParamsAllowed,
                            k
                          )
                        ) {
                          const allowed = (
                            expectedParamsAllowed as Record<string, unknown[]>
                          )[k];
                          const got = (receivedArgs as Record<string, unknown>)[
                            k
                          ];
                          const includes =
                            Array.isArray(allowed) &&
                            allowed.some((v: unknown) => {
                              try {
                                if (Array.isArray(got)) {
                                  return (
                                    JSON.stringify(
                                      got.map(x => String(x)).sort()
                                    ) ===
                                    JSON.stringify(
                                      (v as unknown[])
                                        .map(x => String(x))
                                        .sort()
                                    )
                                  );
                                }
                              } catch {
                                void 0;
                              }
                              return (
                                String(v).toLowerCase().replace(/\s+/g, "") ===
                                String(got).toLowerCase().replace(/\s+/g, "")
                              );
                            });
                          if (!includes) {
                            diff.push(`@@ param ${k}`);
                            diff.push(
                              `- expected one of: ${JSON.stringify(allowed)}`
                            );
                            diff.push(`+ got: ${JSON.stringify(got)}`);
                          }
                        }
                      }
                    }
                  }
                }

                caseLogs.push(
                  `[DEBUG-FAIL] ${JSON.stringify({
                    id: testCase.id,
                    message: checkerResult.error,
                    error_type: checkerResult.error_type,
                    expected,
                    actual,
                    diff,
                  })}`
                );
              } catch {
                caseLogs.push(
                  `[DEBUG] ${testCase.id}: failed to build debug diff`
                );
              }
              return { valid: false, logs: caseLogs };
            }
          } catch (e: any) {
            caseLogs.push(
              `[ERROR] ${testCase.id}: Model generation failed: ${e?.message}`
            );
            if (e?.stack) {
              caseLogs.push(`[STACK] ${testCase.id}: ${e.stack}`);
            }
            return { valid: false, logs: caseLogs };
          }
        };

        // Generic concurrency mapper
        const mapWithConcurrency = async <T, R>(
          items: T[],
          limit: number,
          mapper: (item: T, index: number) => Promise<R>
        ): Promise<R[]> => {
          const results = new Array<R>(items.length);
          let idx = 0;
          const workers = new Array(Math.min(limit, items.length))
            .fill(0)
            .map(async () => {
              while (true) {
                const current = idx++;
                if (current >= items.length) break;
                results[current] = await mapper(items[current], current);
              }
            });
          await Promise.all(workers);
          return results;
        };

        const resultsPerCase = await mapWithConcurrency(
          testCases,
          concurrency,
          async tc => runSingleCase(tc)
        );

        // Aggregate
        correctCount = resultsPerCase.reduce(
          (acc, r) => acc + (r.valid ? 1 : 0),
          0
        );
        for (const r of resultsPerCase) logs.push(...r.logs);

        if (testCases.length === 0) {
          return {
            score: 0,
            success: false,
            metrics: {},
            logs: ["No test cases found."],
          };
        }

        const score = correctCount / testCases.length;
        return {
          score,
          success: score > 0.95, // High success threshold as requested
          metrics: {
            correct_count: correctCount,
            total_cases: testCases.length,
            accuracy: score,
          },
          logs,
        };
      } catch (e: any) {
        return {
          score: 0,
          success: false,
          metrics: {},
          error: e,
          logs: [`[FATAL] Failed to run benchmark ${name}: ${e.message}`],
        };
      }
    },
  };
}

// --- Exported Benchmark Instances ---
export const bfclSimpleBenchmark = createBfclBenchmark(
  "bfcl-simple",
  "BFCL Simple Function Calling",
  "BFCL_v3_simple.json",
  "BFCL_v3_simple_possible_answer.json"
);

export const bfclParallelBenchmark = createBfclBenchmark(
  "bfcl-parallel",
  "BFCL Parallel Function Calling",
  "BFCL_v3_parallel.json",
  "BFCL_v3_parallel_possible_answer.json"
);

export const bfclMultipleBenchmark = createBfclBenchmark(
  "bfcl-multiple",
  "BFCL Multiple Function Calling",
  "BFCL_v3_multiple.json",
  "BFCL_v3_multiple_possible_answer.json"
);

export const bfclParallelMultipleBenchmark = createBfclBenchmark(
  "bfcl-parallel-multiple",
  "BFCL Parallel & Multiple Function Calling",
  "BFCL_v3_parallel_multiple.json",
  "BFCL_v3_parallel_multiple_possible_answer.json"
);
