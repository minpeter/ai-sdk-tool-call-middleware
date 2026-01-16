/**
 * ComplexFuncBench - Complex Function Calling Benchmark
 *
 * This benchmark evaluates models on complex function calling scenarios including:
 * - Multi-step function calls in a single turn
 * - Function calling with constraints
 * - Parameter value reasoning from implicit information
 * - Long parameter values (500+ tokens)
 * - Parallel function calls
 *
 * Dataset: https://huggingface.co/datasets/THUDM/ComplexFuncBench
 * Paper: https://arxiv.org/abs/2501.10132
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { JSONObject } from "@ai-sdk/provider";
import {
  generateText,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  tool,
} from "ai";

import type { BenchmarkResult, LanguageModelV3Benchmark } from "../interfaces";
import { resolveDataDir } from "../utils/paths";

// Regex constants for performance
const LINE_SPLIT_REGEX = /\r?\n/;

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

interface Message {
  role: string;
  content: string;
}

interface TestCase {
  id: string;
  question: Message[];
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
  ground_truth: Record<string, unknown>[];
}

interface ToolCall {
  toolName?: string;
  name?: string;
  args?: unknown;
}

// --- Helper Functions ---

/**
 * Standardizes a string for comparison.
 */
function standardizeString(input: string): string {
  if (typeof input !== "string") {
    return input;
  }
  return input.toLowerCase().trim();
}

/**
 * Checks if two values match with tolerance for ComplexFuncBench
 */
function valuesMatch(modelValue: unknown, expectedValue: unknown): boolean {
  if (modelValue === expectedValue) {
    return true;
  }

  if (typeof modelValue === "string" && typeof expectedValue === "string") {
    return standardizeString(modelValue) === standardizeString(expectedValue);
  }

  if (typeof modelValue === "number" && typeof expectedValue === "string") {
    return (
      modelValue.toString() === expectedValue ||
      modelValue === Number(expectedValue)
    );
  }
  if (typeof modelValue === "string" && typeof expectedValue === "number") {
    return (
      modelValue === expectedValue.toString() ||
      Number(modelValue) === expectedValue
    );
  }

  if (
    typeof modelValue === "object" &&
    modelValue !== null &&
    typeof expectedValue === "object" &&
    expectedValue !== null
  ) {
    try {
      return JSON.stringify(modelValue) === JSON.stringify(expectedValue);
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Validate function name match
 */
function validateFunctionName(
  modelFuncName: string | undefined,
  expectedFuncName: string
): { valid: boolean; error?: string; error_type?: string } {
  if (modelFuncName !== expectedFuncName) {
    return {
      valid: false,
      error: `Function name mismatch: expected '${expectedFuncName}', got '${modelFuncName}'`,
      error_type: "function_name_mismatch",
    };
  }
  return { valid: true };
}

/**
 * Validate required parameters are present
 */
function validateRequiredParams(
  requiredParams: string[],
  modelArgs: Record<string, unknown>,
  expectedArgs: Record<string, unknown>
): { valid: boolean; error?: string; error_type?: string } {
  for (const param of requiredParams) {
    if (!(param in modelArgs) && param in expectedArgs) {
      return {
        valid: false,
        error: `Missing required parameter: '${param}'`,
        error_type: "missing_required_param",
      };
    }
  }
  return { valid: true };
}

/**
 * Validate parameter values match
 */
function validateParamValues(
  expectedArgs: Record<string, unknown>,
  modelArgs: Record<string, unknown>,
  requiredParams: string[]
): { valid: boolean; error?: string; error_type?: string } {
  for (const [paramName, expectedValue] of Object.entries(expectedArgs)) {
    if (!(paramName in modelArgs)) {
      if (!requiredParams.includes(paramName)) {
        continue;
      }
      return {
        valid: false,
        error: `Missing parameter: '${paramName}'`,
        error_type: "missing_param",
      };
    }

    const modelValue = modelArgs[paramName];
    if (!valuesMatch(modelValue, expectedValue)) {
      return {
        valid: false,
        error: `Parameter '${paramName}' value mismatch: expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(modelValue)}`,
        error_type: "value_mismatch",
      };
    }
  }
  return { valid: true };
}

/**
 * Check a single function call against expected
 */
function checkFunctionCall(
  modelCall: ToolCall,
  expected: Record<string, unknown>,
  toolSpecs: ToolSpec[]
): { valid: boolean; error?: string; error_type?: string } {
  const expectedFuncName = Object.keys(expected)[0];
  const expectedArgs = expected[expectedFuncName] as Record<string, unknown>;
  const modelFuncName = modelCall.toolName ?? modelCall.name;
  const modelArgs = (modelCall.args ?? {}) as Record<string, unknown>;

  const nameResult = validateFunctionName(modelFuncName, expectedFuncName);
  if (!nameResult.valid) {
    return nameResult;
  }

  const toolSpec = toolSpecs.find((t) => t.name === expectedFuncName);
  const requiredParams = toolSpec?.parameters?.required ?? [];

  const requiredResult = validateRequiredParams(
    requiredParams,
    modelArgs,
    expectedArgs
  );
  if (!requiredResult.valid) {
    return requiredResult;
  }

  return validateParamValues(expectedArgs, modelArgs, requiredParams);
}

/**
 * Check all function calls (parallel/single)
 */
function checkAllFunctionCalls(
  modelCalls: ToolCall[],
  expectedCalls: Record<string, unknown>[],
  toolSpecs: ToolSpec[]
): { valid: boolean; error?: string; error_type?: string } {
  if (modelCalls.length !== expectedCalls.length) {
    return {
      valid: false,
      error: `Wrong number of function calls: expected ${expectedCalls.length}, got ${modelCalls.length}`,
      error_type: "wrong_call_count",
    };
  }

  if (expectedCalls.length === 1) {
    return checkFunctionCall(modelCalls[0], expectedCalls[0], toolSpecs);
  }

  const matchedIndices = new Set<number>();
  for (const expected of expectedCalls) {
    let foundMatch = false;
    for (let i = 0; i < modelCalls.length; i++) {
      if (matchedIndices.has(i)) {
        continue;
      }

      const result = checkFunctionCall(modelCalls[i], expected, toolSpecs);
      if (result.valid) {
        matchedIndices.add(i);
        foundMatch = true;
        break;
      }
    }

    if (!foundMatch) {
      const expectedFuncName = Object.keys(expected)[0];
      return {
        valid: false,
        error: `Could not find matching call for function '${expectedFuncName}'`,
        error_type: "no_matching_call",
      };
    }
  }

  return { valid: true };
}

// --- Schema Fixers ---
const fixSchemaType = (copy: ToolSchemaObject): void => {
  if (!copy.type) {
    return;
  }
  if (copy.type === "dict") {
    copy.type = "object";
  }
  if (copy.type === "tuple") {
    copy.type = "array";
  }
  if (copy.type === "integer" || copy.type === "float") {
    copy.type = "number";
  }
};

const fixSchema = (schema: unknown): unknown => {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }
  const copy = Array.isArray(schema)
    ? schema.map((v) => fixSchema(v))
    : ({ ...(schema as Record<string, unknown>) } as ToolSchemaObject);

  if (!Array.isArray(copy)) {
    fixSchemaType(copy);
    if (copy.properties && typeof copy.properties === "object") {
      for (const k of Object.keys(copy.properties)) {
        (copy.properties as Record<string, unknown>)[k] = fixSchema(
          (copy.properties as Record<string, unknown>)[k]
        );
      }
    }
    if (copy.items) {
      copy.items = fixSchema(copy.items);
    }
  }
  return copy;
};

// --- Tool Builder ---
function buildTools(tools: ToolSpec[]) {
  const nameMap = new Map<string, string>();
  const transformedTools: TransformedTool[] = tools.map((t) => {
    const fixed = fixSchema(t.parameters) as ToolSchemaObject;
    const inputSchema =
      fixed &&
      typeof fixed === "object" &&
      (fixed as ToolSchemaObject).type === "object"
        ? (fixed as ToolSchemaObject)
        : { type: "object", properties: {} };

    const sanitized =
      t.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "tool";
    nameMap.set(sanitized, t.name);

    return {
      type: "function" as const,
      name: sanitized,
      description: t.description,
      inputSchema,
    };
  });

  const toolsMap = Object.fromEntries(
    transformedTools.map((t) => [
      t.name,
      tool({
        description:
          typeof t.description === "string" ? t.description : undefined,
        inputSchema: jsonSchema(t.inputSchema as Record<string, unknown>),
      }),
    ])
  );

  return { nameMap, toolsMap };
}

// --- Concurrency Mapper ---
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrencyLimit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let idx = 0;
  const workers = new Array(Math.min(concurrencyLimit, items.length))
    .fill(0)
    .map(async () => {
      while (true) {
        const current = idx;
        idx += 1;
        if (current >= items.length) {
          break;
        }
        results[current] = await mapper(items[current]);
      }
    });
  await Promise.all(workers);
  return results;
}

// --- Test Case Runner ---
async function runSingleCase(
  testCase: TestCase,
  model: LanguageModel,
  possibleAnswersMap: Map<string, PossibleAnswer>,
  temperature: number | undefined,
  maxTokens: number | undefined,
  externalProviderOptions?: Record<string, Record<string, unknown>>
): Promise<{ valid: boolean; logs: string[] }> {
  const caseLogs: string[] = [];
  const { function: tools, question: messages } = testCase;

  try {
    const { nameMap, toolsMap } = buildTools(tools);

    const debugSummaryRef: { originalText?: string; toolCalls?: string } = {};
    const internalProviderOptions: Record<string, JSONObject> = {
      toolCallMiddleware: { debugSummary: debugSummaryRef },
    };
    const mergedProviderOptions: Record<string, JSONObject> = {
      ...(externalProviderOptions as Record<string, JSONObject>),
      ...internalProviderOptions,
    };

    const { toolCalls, finishReason } = await generateText({
      model,
      messages: messages as unknown as ModelMessage[],
      tools: toolsMap,
      toolChoice: "auto",
      providerOptions: mergedProviderOptions,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
    });

    const restoredCalls = (toolCalls ?? []).map((c) => {
      const rawName =
        (c as Record<string, unknown>).toolName ??
        (c as Record<string, unknown>).name;
      const originalName = nameMap.get(rawName as string) ?? rawName;
      return {
        toolName: originalName,
        name: originalName,
        args:
          (c as Record<string, unknown>).input ??
          (c as Record<string, unknown>).args ??
          {},
      };
    });

    caseLogs.push(
      `[DEBUG] ${testCase.id}: toolCalls=${JSON.stringify(restoredCalls)}, finishReason=${finishReason}`
    );

    const possibleAnswer = possibleAnswersMap.get(testCase.id);
    if (!possibleAnswer) {
      throw new Error(`No possible answer for id: ${testCase.id}`);
    }

    const checkerResult = checkAllFunctionCalls(
      restoredCalls as ToolCall[],
      possibleAnswer.ground_truth,
      tools as ToolSpec[]
    );

    if (checkerResult.valid) {
      caseLogs.push(`[PASS] ${testCase.id}`);
      return { valid: true, logs: caseLogs };
    }

    caseLogs.push(`[FAIL] ${testCase.id}: ${checkerResult.error}`);
    return { valid: false, logs: caseLogs };
  } catch (e: unknown) {
    caseLogs.push(`[ERROR] ${testCase.id}: ${(e as Error)?.message}`);
    return { valid: false, logs: caseLogs };
  }
}

// --- Data Loading ---
async function loadTestData(dataPath: string, testDataFile: string) {
  const testCasesJson = await fs.readFile(
    path.join(dataPath, testDataFile),
    "utf-8"
  );
  return testCasesJson
    .split(LINE_SPLIT_REGEX)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TestCase);
}

async function loadAnswerData(dataPath: string, answerDataFile: string) {
  const answersJson = await fs.readFile(
    path.join(dataPath, answerDataFile),
    "utf-8"
  );
  const answers: PossibleAnswer[] = answersJson
    .split(LINE_SPLIT_REGEX)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  return new Map(answers.map((ans) => [ans.id, ans]));
}

function getConfigValues(config?: Record<string, unknown>) {
  const limitEnv = process.env.COMPLEXFUNCBENCH_LIMIT;
  const limit = limitEnv ? Number(limitEnv) : undefined;

  const concurrencyEnv = process.env.COMPLEXFUNCBENCH_CONCURRENCY;
  const concurrency =
    concurrencyEnv && Number.isFinite(Number(concurrencyEnv))
      ? Math.max(1, Number(concurrencyEnv))
      : 4;

  const temperature =
    typeof config?.temperature === "number" ? config.temperature : undefined;
  const maxTokens =
    typeof config?.maxTokens === "number" ? config.maxTokens : undefined;
  const externalProviderOptions = config?.providerOptions as
    | Record<string, Record<string, unknown>>
    | undefined;

  return {
    limit,
    concurrency,
    temperature,
    maxTokens,
    externalProviderOptions,
  };
}

function aggregateResults(
  resultsPerCase: { valid: boolean; logs: string[] }[],
  testCases: TestCase[]
): BenchmarkResult {
  const logs: string[] = [];
  const correctCount = resultsPerCase.reduce(
    (acc, r) => acc + (r.valid ? 1 : 0),
    0
  );

  for (const r of resultsPerCase) {
    logs.push(...r.logs);
  }

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
    success: score > 0.5,
    metrics: {
      correct_count: correctCount,
      total_cases: testCases.length,
      accuracy: score,
    },
    logs,
  };
}

// --- Benchmark Factory ---
function createComplexFuncBenchBenchmark(
  name: string,
  description: string,
  testDataFile: string,
  answerDataFile: string
): LanguageModelV3Benchmark {
  return {
    name,
    version: "1.0.0",
    description,
    async run(
      model: LanguageModel,
      config?: Record<string, unknown>
    ): Promise<BenchmarkResult> {
      const logs: string[] = [];

      try {
        const dataPath = resolveDataDir();
        logs.push(`[INFO] Using data dir: ${dataPath}`);

        let testCases = await loadTestData(dataPath, testDataFile);
        const possibleAnswersMap = await loadAnswerData(
          dataPath,
          answerDataFile
        );

        const {
          limit,
          concurrency,
          temperature,
          maxTokens,
          externalProviderOptions,
        } = getConfigValues(config);

        if (limit && Number.isFinite(limit) && limit > 0) {
          testCases = testCases.slice(0, limit);
          logs.push(`[INFO] Limiting test cases to ${limit}`);
        }

        logs.push(
          `[INFO] Running ${testCases.length} test cases with concurrency=${concurrency}`
        );

        const resultsPerCase = await mapWithConcurrency(
          testCases,
          concurrency,
          (tc) =>
            runSingleCase(
              tc,
              model,
              possibleAnswersMap,
              temperature,
              maxTokens,
              externalProviderOptions
            )
        );

        const result = aggregateResults(resultsPerCase, testCases);
        result.logs = [...logs, ...(result.logs ?? [])];
        return result;
      } catch (e: unknown) {
        return {
          score: 0,
          success: false,
          metrics: {},
          error: e as Error,
          logs: [
            `[FATAL] Failed to run benchmark ${name}: ${(e as Error).message}`,
          ],
        };
      }
    },
  };
}

// --- Exported Benchmark Instances ---

/**
 * ComplexFuncBench benchmark - tests complex function calling scenarios
 * including multi-step calls, constraints, parameter reasoning, and long parameters.
 */
export const complexFuncBenchBenchmark = createComplexFuncBenchBenchmark(
  "complex-func-bench",
  "ComplexFuncBench - Complex Function Calling (multi-step, constraints, long params)",
  "ComplexFuncBench.jsonl",
  "ComplexFuncBench_possible_answer.jsonl"
);
