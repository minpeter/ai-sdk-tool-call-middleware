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
import {
  type FunctionDescription,
  multipleFunctionChecker,
  parallelFunctionCheckerNoOrder,
  simpleFunctionChecker,
  type ToolCall,
} from "./bfcl/ast-checker";

// Resolve data files relative to this module using ESM-safe utilities

// Regex constants for performance
const LINE_SPLIT_REGEX = /\r?\n/;
const NUMERIC_STRING_REGEX = /^\d+$/;
const DIFF_NUMERIC_EXTRACT_REGEX = /:\s*([\d.]+)/;

// Helper function to convert ground truth to morphXML format
function convertGroundTruthToXML(call: Record<string, unknown>): string {
  const keys = Object.keys(call);
  if (keys.length === 0) {
    return "<empty_call />";
  }
  const funcName = keys[0];
  if (!funcName) {
    return "<undefined_function />";
  }
  const params = call[funcName] as Record<string, unknown>;
  if (!params || typeof params !== "object") {
    return `<${funcName} />`;
  }
  let xml = `<${funcName}>\n`;
  for (const [key, value] of Object.entries(params)) {
    // Value is typically an array [value, ...alternatives]
    const displayValue = Array.isArray(value) ? value[0] : value;
    let valueStr: string;
    if (typeof displayValue === "string") {
      valueStr = displayValue;
    } else if (displayValue === null || displayValue === undefined) {
      valueStr = "";
    } else {
      valueStr = JSON.stringify(displayValue);
    }
    xml += `  <${key}>${valueStr}</${key}>\n`;
  }
  xml += `</${funcName}>`;
  return xml;
}

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
function extractCategory(id: string): string {
  if (id.startsWith("parallel_multiple")) {
    return "parallel_multiple";
  }
  if (id.startsWith("simple_python")) {
    return "simple";
  }
  if (id.startsWith("simple_java")) {
    return "simple";
  }
  if (id.startsWith("simple_javascript")) {
    return "simple";
  }
  if (id.startsWith("parallel")) {
    return "parallel";
  }
  if (id.startsWith("multiple")) {
    return "multiple";
  }
  if (id.startsWith("simple")) {
    return "simple";
  }
  return id.split("_")[0];
}

function check(
  testCase: TestCase,
  modelOutput: unknown, // This is an array of tool_calls
  possibleAnswer: PossibleAnswer
): { valid: boolean; error?: string; error_type?: string } {
  const category = extractCategory(testCase.id);

  try {
    switch (category) {
      case "simple": {
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
          (possibleAnswer.ground_truth as Record<string, unknown>[])[0]
        );
      }
      case "multiple": {
        return multipleFunctionChecker(
          testCase.function as unknown as FunctionDescription[],
          modelOutput as ToolCall[],
          possibleAnswer.ground_truth as Record<string, unknown>[]
        );
      }
      case "parallel":
      case "parallel_multiple": {
        return parallelFunctionCheckerNoOrder(
          testCase.function as unknown as FunctionDescription[],
          modelOutput as ToolCall[],
          possibleAnswer.ground_truth as Record<string, unknown>[]
        );
      }
      default: {
        return { valid: true };
      }
    }
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
          .split(LINE_SPLIT_REGEX)
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line));
        const possibleAnswers: PossibleAnswer[] = possibleAnswersJson
          .split(LINE_SPLIT_REGEX)
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line));
        const possibleAnswersMap = new Map(
          possibleAnswers.map((ans) => [ans.id, ans])
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

        // Helper: fix BFCL JSON schema type field
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

        // Helper: fix BFCL JSON schema properties recursively
        const fixSchemaProperties = (
          copy: ToolSchemaObject,
          fixSchemaFn: (schema: unknown) => unknown
        ): void => {
          if (!copy.properties || typeof copy.properties !== "object") {
            return;
          }
          for (const k of Object.keys(copy.properties)) {
            (copy.properties as Record<string, unknown>)[k] = fixSchemaFn(
              (copy.properties as Record<string, unknown>)[k]
            );
          }
        };

        // Helper: fix BFCL JSON schema types to OpenAI-compatible JSON Schema
        const fixSchema = (schema: unknown): unknown => {
          if (!schema || typeof schema !== "object") {
            return { type: "object", properties: {} };
          }
          const copy: ToolSchemaObject | unknown[] = Array.isArray(schema)
            ? (schema as unknown[]).map((v) => fixSchema(v))
            : ({ ...(schema as Record<string, unknown>) } as ToolSchemaObject);
          if (!Array.isArray(copy)) {
            fixSchemaType(copy);
            fixSchemaProperties(copy, fixSchema);
            if (copy.items) {
              copy.items = fixSchema(copy.items);
            }
            return copy;
          }
          return copy;
        };

        // Helper: Flatten BFCL message shape
        const flattenMessages = (
          messages: Message[] | Message[][]
        ): Message[] =>
          Array.isArray(messages) &&
          (messages as unknown[]).some((m) => Array.isArray(m))
            ? (messages as unknown[] as Message[][]).flat(1)
            : (messages as Message[]);

        // Helper: Sanitize tool name for OpenAI compatibility
        const sanitizeName = (toolName: string): string => {
          const s = toolName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
          return s.length > 0 ? s : "tool";
        };

        // Helper: Build transformed tools and name mapping
        const buildTransformedTools = (
          tools: ToolSpec[],
          fixSchemaFn: (schema: unknown) => unknown
        ): {
          transformedTools: TransformedTool[];
          nameMap: Map<string, string>;
        } => {
          const nameMap = new Map<string, string>();
          const transformedTools: TransformedTool[] = tools.map((t) => {
            const fixed = fixSchemaFn(t.parameters);
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
              inputSchema,
            };
          });
          return { transformedTools, nameMap };
        };

        // Helper: Parse middleware debug tool calls
        const parseDebugToolCalls = (
          raw: string | undefined
        ): Array<{ toolName?: string; input?: unknown }> => {
          if (!raw) {
            return [];
          }
          try {
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr : [];
          } catch {
            return [];
          }
        };

        // Helper: Get sanitized name from index or raw name
        const getSanitizedName = (
          rawName: unknown,
          transformedTools: TransformedTool[]
        ): unknown => {
          if (
            typeof rawName === "string" &&
            NUMERIC_STRING_REGEX.test(rawName)
          ) {
            return transformedTools[Number(rawName)]?.name ?? rawName;
          }
          return rawName;
        };

        // Helper: Parse arguments from various formats
        const parseToolArgs = (extractedArgs: unknown): unknown => {
          if (typeof extractedArgs !== "string") {
            return extractedArgs;
          }
          try {
            return JSON.parse(extractedArgs);
          } catch {
            // leave as string if not JSON
            return extractedArgs;
          }
        };

        // Helper: Restore original tool names in tool calls
        const restoreToolCalls = (
          toolCalls: unknown[],
          nameMap: Map<string, string>,
          transformedTools: TransformedTool[]
        ): unknown[] =>
          (toolCalls || []).map((c: unknown) => {
            const call = c as Record<string, unknown>;
            const rawName = call.toolName ?? call.name;
            const sanitizedFromIndex = getSanitizedName(
              rawName,
              transformedTools
            );
            const originalName =
              nameMap.get(sanitizedFromIndex as string) ?? sanitizedFromIndex;
            const extractedArgs =
              call.args ??
              call.arguments ??
              call.input ??
              call.params ??
              call.parameters;
            const parsedArgs = parseToolArgs(extractedArgs);
            return {
              ...call,
              toolName: originalName,
              name: originalName,
              args: parsedArgs ?? {},
            };
          });

        // Helper: Summarize args for stable output
        const summarizeArgs = (args: unknown): unknown => {
          if (args == null) {
            return args;
          }
          if (typeof args !== "object") {
            return args;
          }
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

        // Helper: Generate parameter mismatch diff
        const generateParamMismatchDiff = (
          paramName: string,
          allowed: unknown,
          got: unknown
        ): string[] => {
          const diffLines: string[] = [];
          diffLines.push(`@@ param ${paramName}`);
          const allowedArray = Array.isArray(allowed)
            ? (allowed as unknown[])
            : [allowed as unknown];
          const expectedLine = (() => {
            if (allowedArray.length === 1) {
              return `- expected: ${JSON.stringify(allowedArray[0])}`;
            }
            const formatted = allowedArray
              .map((v) =>
                Array.isArray(v) || (typeof v === "object" && v !== null)
                  ? JSON.stringify(v)
                  : String(v)
              )
              .join(", ");
            return `- expected one of: ${formatted}`;
          })();
          diffLines.push(expectedLine);
          diffLines.push(`+ got: ${JSON.stringify(got)}`);
          return diffLines;
        };

        // Helper: Check if param value matches allowed values
        const paramValueMatches = (allowed: unknown, got: unknown): boolean => {
          if (!Array.isArray(allowed)) {
            return false;
          }
          return allowed.some((v: unknown) => {
            try {
              if (Array.isArray(got)) {
                return (
                  JSON.stringify(got.map((x) => String(x)).sort()) ===
                  JSON.stringify((v as unknown[]).map((x) => String(x)).sort())
                );
              }
            } catch {
              // Ignore parse errors
            }
            return (
              String(v).toLowerCase().replace(/\s+/g, "") ===
              String(got).toLowerCase().replace(/\s+/g, "")
            );
          });
        };

        // Helper: Check function name mismatch
        const checkFunctionNameMismatch = (
          expectedName: unknown,
          receivedName: unknown,
          diff: string[]
        ): void => {
          if (expectedName !== receivedName) {
            diff.push("@@ function name");
            diff.push(`- ${expectedName}`);
            diff.push(`+ ${receivedName}`);
          }
        };

        // Helper: Check missing required params
        const checkMissingParams = (
          required: string[],
          receivedArgs: Record<string, unknown>,
          diff: string[]
        ): void => {
          for (const req of required) {
            if (!(req in receivedArgs)) {
              diff.push(`- missing required param: ${req}`);
            }
          }
        };

        // Helper: Check unexpected params
        const checkUnexpectedParams = (
          expectedParams: Record<string, unknown>,
          receivedArgs: Record<string, unknown>,
          diff: string[]
        ): void => {
          for (const k of Object.keys(receivedArgs)) {
            if (!(k in expectedParams)) {
              diff.push(`+ unexpected param: ${k}`);
            }
          }
        };

        // Helper: Check param value mismatches
        const checkParamValueMismatches = (
          expectedParams: Record<string, unknown>,
          receivedArgs: Record<string, unknown>,
          diff: string[]
        ): void => {
          for (const k of Object.keys(receivedArgs)) {
            if (k in expectedParams) {
              const allowed = (expectedParams as Record<string, unknown[]>)[k];
              const got = receivedArgs[k];
              if (!paramValueMatches(allowed, got)) {
                diff.push(...generateParamMismatchDiff(k, allowed, got));
              }
            }
          }
        };

        // Helper: Build diff for simple test case
        const buildSimpleDiff = (
          tools: ToolSpec[],
          possibleAnswer: PossibleAnswer,
          restoredCalls: unknown[]
        ): {
          expected: Record<string, unknown>;
          actual: Record<string, unknown>;
          diff: string[];
        } => {
          const funcDesc = tools[0];
          const gt = (possibleAnswer as { ground_truth?: unknown[] })
            .ground_truth?.[0] as Record<string, unknown> | undefined;
          const expectedFuncName = funcDesc?.name;
          const expectedParams = gt ? gt[Object.keys(gt)[0]] : undefined;
          const received = (restoredCalls as Record<string, unknown>[])[0];
          const receivedName = received?.toolName ?? received?.name;
          const receivedArgs = summarizeArgs(received?.args);

          const expected: Record<string, unknown> = {
            function: expectedFuncName,
            params: expectedParams,
          };
          const actual: Record<string, unknown> = {
            function: receivedName,
            args: receivedArgs,
          };
          const diff: string[] = [];

          checkFunctionNameMismatch(expectedFuncName, receivedName, diff);

          if (
            expectedParams &&
            receivedArgs &&
            typeof receivedArgs === "object" &&
            receivedArgs !== null
          ) {
            const required = (funcDesc?.parameters?.required ?? []) as string[];
            checkMissingParams(
              required,
              receivedArgs as Record<string, unknown>,
              diff
            );
            checkUnexpectedParams(
              expectedParams as Record<string, unknown>,
              receivedArgs as Record<string, unknown>,
              diff
            );
            checkParamValueMismatches(
              expectedParams as Record<string, unknown>,
              receivedArgs as Record<string, unknown>,
              diff
            );
          }

          return { expected, actual, diff };
        };

        // Helper: Check call count mismatch
        const checkCallCountMismatch = (
          expectedCount: number,
          actualCount: number,
          diff: string[]
        ): void => {
          if (expectedCount !== actualCount) {
            diff.push("@@ call count");
            diff.push(`- expected ${expectedCount}`);
            diff.push(`+ got ${actualCount}`);
          }
        };

        // Helper: Add missing and extra functions to diff
        const addMissingAndExtraFunctions = (
          expectedNames: unknown[],
          actualNames: unknown[],
          diff: string[]
        ): void => {
          const missing = expectedNames.filter((n) => !actualNames.includes(n));
          const extra = actualNames.filter((n) => !expectedNames.includes(n));
          for (const m of missing) {
            diff.push(`- missing function: ${m}`);
          }
          for (const e of extra) {
            diff.push(`+ unexpected function: ${e}`);
          }
        };

        // Helper: Find matching call index
        const findMatchingCallIndex = (
          fname: string,
          restoredCalls: Record<string, unknown>[],
          usedActual: Set<number>
        ): number => {
          for (let i = 0; i < restoredCalls.length; i += 1) {
            if (usedActual.has(i)) {
              continue;
            }
            const rc = restoredCalls[i];
            const rcName = rc?.toolName ?? rc?.name;
            if (rcName === fname) {
              return i;
            }
          }
          return -1;
        };

        // Helper: Validate function parameters
        const validateFunctionParams = (options: {
          receivedArgs: Record<string, unknown>;
          expectedParamsAllowed: Record<string, unknown>;
          requiredParams: string[];
          diff: string[];
        }): void => {
          const { receivedArgs, expectedParamsAllowed, requiredParams, diff } =
            options;
          checkMissingParams(requiredParams, receivedArgs, diff);
          checkUnexpectedParams(expectedParamsAllowed, receivedArgs, diff);
          checkParamValueMismatches(expectedParamsAllowed, receivedArgs, diff);
        };

        // Helper: Process single expected function call
        const processExpectedCall = (options: {
          expectedObj: Record<string, unknown>;
          restoredCalls: Record<string, unknown>[];
          tools: ToolSpec[];
          usedActual: Set<number>;
          diff: string[];
        }): void => {
          const { expectedObj, restoredCalls, tools, usedActual, diff } =
            options;
          const fname = Object.keys(expectedObj)[0];
          const matchedIndex = findMatchingCallIndex(
            fname,
            restoredCalls,
            usedActual
          );

          if (matchedIndex === -1) {
            return;
          }

          usedActual.add(matchedIndex);
          const received = restoredCalls[matchedIndex];
          const receivedArgs = summarizeArgs(received?.args);
          const expectedParamsAllowed = expectedObj[fname] as Record<
            string,
            unknown
          >;
          const funcDesc = tools.find((t: ToolSpec) => t.name === fname);
          const requiredParams = (funcDesc?.parameters?.required ??
            []) as string[];

          diff.push(`@@ function ${fname}`);

          if (
            expectedParamsAllowed &&
            receivedArgs &&
            typeof receivedArgs === "object" &&
            receivedArgs !== null
          ) {
            validateFunctionParams({
              receivedArgs: receivedArgs as Record<string, unknown>,
              expectedParamsAllowed,
              requiredParams,
              diff,
            });
          }
        };

        // Helper: Build diff for parallel/multiple test case
        const buildParallelDiff = (
          tools: ToolSpec[],
          possibleAnswer: PossibleAnswer,
          restoredCalls: unknown[]
        ): {
          expected: Record<string, unknown>;
          actual: Record<string, unknown>;
          diff: string[];
        } => {
          const gtArr: Record<string, unknown>[] =
            (
              possibleAnswer as {
                ground_truth?: Record<string, unknown>[];
              }
            ).ground_truth ?? [];
          const expectedNames = gtArr.map((g) => Object.keys(g)[0]);
          const actualNames = (restoredCalls as Record<string, unknown>[]).map(
            (c) => c.toolName ?? c.name
          );

          const expected: Record<string, unknown> = {
            functions: expectedNames,
          };
          const actual: Record<string, unknown> = { functions: actualNames };
          const diff: string[] = [];

          checkCallCountMismatch(
            expectedNames.length,
            actualNames.length,
            diff
          );
          addMissingAndExtraFunctions(expectedNames, actualNames, diff);

          const usedActual = new Set<number>();
          for (const expectedObj of gtArr) {
            processExpectedCall({
              expectedObj,
              restoredCalls: restoredCalls as Record<string, unknown>[],
              tools,
              usedActual,
              diff,
            });
          }

          return { expected, actual, diff };
        };

        // Concurrency control via env BFCL_CONCURRENCY (default 16)
        const concurrencyEnv = process.env.BFCL_CONCURRENCY;
        const concurrency =
          concurrencyEnv && Number.isFinite(Number(concurrencyEnv))
            ? Math.max(1, Number(concurrencyEnv))
            : 16;
        logs.push(
          `[INFO] Running ${testCases.length} test cases with concurrency=${concurrency}`
        );

        // Helper: Log first tool debug info
        const logFirstToolDebug = (
          transformedTools: TransformedTool[],
          testCaseId: string,
          caseLogs: string[]
        ): void => {
          try {
            const firstTool = transformedTools[0];
            const schemaType =
              firstTool?.inputSchema?.type ??
              (
                (firstTool?.inputSchema as Record<string, unknown> | undefined)
                  ?.jsonSchema as Record<string, unknown> | undefined
              )?.type;
            caseLogs.push(
              `[DEBUG] ${testCaseId}: firstTool=${JSON.stringify(firstTool)}, schemaType=${schemaType}`
            );
          } catch (e: unknown) {
            caseLogs.push(
              `[DEBUG] ${testCaseId}: failed to introspect tools: ${(e as Error).message}`
            );
          }
        };

        // Helper: Log raw tool calls
        const logRawToolCalls = (options: {
          toolCalls: unknown;
          finishReason: unknown;
          text: unknown;
          testCaseId: string;
          caseLogs: string[];
        }): void => {
          const { toolCalls, finishReason, text, testCaseId, caseLogs } =
            options;
          try {
            caseLogs.push(
              `[DEBUG] ${testCaseId}: rawToolCalls=${JSON.stringify(toolCalls)}, finishReason=${finishReason}, text=${JSON.stringify(text)}`
            );
          } catch {
            caseLogs.push(
              `[DEBUG] ${testCaseId}: failed to serialize toolCalls`
            );
          }
        };

        const hasPercentPattern = (diff: string[]): boolean => {
          return diff.some((d) => {
            if (!(d.startsWith("+ got:") || d.startsWith("- expected:"))) {
              return false;
            }
            const numMatch = d.match(DIFF_NUMERIC_EXTRACT_REGEX);
            if (!numMatch) {
              return false;
            }
            const num = Number.parseFloat(numMatch[1]);
            return num >= 1 && num <= 100;
          });
        };

        const isValueError = (
          errorType: string | undefined,
          diff: string[]
        ): boolean => {
          return (
            !!errorType?.includes("value_error") ||
            diff.some((d) => d.startsWith("@@ param"))
          );
        };

        const isFunctionNameError = (
          errorType: string | undefined,
          diff: string[]
        ): boolean => {
          return (
            !!errorType?.includes("wrong_func_name") ||
            diff.some((d) => d.includes("function name"))
          );
        };

        const isMissingParamError = (
          errorType: string | undefined,
          diff: string[]
        ): boolean => {
          return (
            !!errorType?.includes("missing_required") ||
            diff.some((d) => d.includes("missing required param"))
          );
        };

        const isUnexpectedParamError = (
          errorType: string | undefined,
          diff: string[]
        ): boolean => {
          return (
            !!errorType?.includes("unexpected_param") ||
            diff.some((d) => d.includes("unexpected param"))
          );
        };

        type FailureClassifier = (
          errorType: string | undefined,
          diff: string[]
        ) => boolean;

        const classifyByErrorPatterns = (
          errorType: string | undefined,
          diff: string[]
        ): string | null => {
          const patterns: [FailureClassifier, string][] = [
            [
              isValueError,
              hasPercentPattern(diff)
                ? "PARAM_VALUE_PERCENT"
                : "PARAM_VALUE_MISMATCH",
            ],
            [isFunctionNameError, "WRONG_FUNCTION"],
            [isMissingParamError, "MISSING_PARAMS"],
            [isUnexpectedParamError, "UNEXPECTED_PARAMS"],
          ];

          for (const [classifier, result] of patterns) {
            if (classifier(errorType, diff)) {
              return result;
            }
          }

          if (errorType?.includes("cannot_find_match")) {
            return "NO_MATCH";
          }

          return null;
        };

        const classifyByCallCount = (
          actualCount: number,
          expectedCount: number
        ): string | null => {
          if (actualCount === 0 && expectedCount > 0) {
            return "PARSE_FAILURE";
          }
          if (actualCount > 0 && actualCount < expectedCount) {
            return "PARTIAL_CALLS";
          }
          if (actualCount > expectedCount) {
            return "EXTRA_CALLS";
          }
          return null;
        };

        const classifyFailureType = (options: {
          errorType: string | undefined;
          restoredCalls: unknown[];
          expectedCount: number;
          diff: string[];
        }): string => {
          const { errorType, restoredCalls, expectedCount, diff } = options;
          const actualCount = Array.isArray(restoredCalls)
            ? restoredCalls.length
            : 0;

          const countBasedResult = classifyByCallCount(
            actualCount,
            expectedCount
          );
          if (countBasedResult) {
            return countBasedResult;
          }

          const patternBasedResult = classifyByErrorPatterns(errorType, diff);
          if (patternBasedResult) {
            return patternBasedResult;
          }

          return "OTHER";
        };

        const extractRawModelText = (
          mwOriginalText: string | undefined,
          text: unknown
        ): string => {
          if (mwOriginalText && mwOriginalText.length > 0) {
            return mwOriginalText;
          }
          if (typeof text === "string") {
            return text;
          }
          return "";
        };

        const extractLastUserQuery = (flatMessages: Message[]): string => {
          const reversed = [...flatMessages].reverse();
          const found = reversed.find((m) => (m as Message).role === "user") as
            | Message
            | undefined;
          const content = found?.content ?? "";
          return content.length > 200 ? `${content.slice(0, 200)}...` : content;
        };

        const truncateText = (text: string, maxLen: number): string => {
          return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
        };

        const logFailureDetails = (options: {
          testCase: TestCase;
          tools: ToolSpec[];
          possibleAnswer: PossibleAnswer;
          restoredCalls: unknown[];
          checkerResult: {
            valid: boolean;
            error?: string;
            error_type?: string;
          };
          flatMessages: Message[];
          mwOriginalText: string | undefined;
          text: unknown;
          finishReason: unknown;
          mwParsedToolCalls: { toolName?: string; input?: unknown }[];
          caseLogs: string[];
        }): void => {
          const {
            testCase,
            tools,
            possibleAnswer,
            restoredCalls,
            checkerResult,
            flatMessages,
            mwOriginalText,
            text,
            finishReason,
            mwParsedToolCalls,
            caseLogs,
          } = options;

          try {
            const category = testCase.id.split("_")[0];
            const { expected, actual, diff } =
              category === "simple"
                ? buildSimpleDiff(tools, possibleAnswer, restoredCalls)
                : buildParallelDiff(tools, possibleAnswer, restoredCalls);

            const gtArr = (possibleAnswer as { ground_truth?: unknown[] })
              .ground_truth;
            const expectedCount = Array.isArray(gtArr) ? gtArr.length : 1;

            const rawModelText = extractRawModelText(mwOriginalText, text);
            const lastUserQuery = extractLastUserQuery(flatMessages);

            const failurePayload = {
              id: testCase.id,
              category: classifyFailureType({
                errorType: checkerResult.error_type,
                restoredCalls,
                expectedCount,
                diff,
              }),
              message: checkerResult.error,
              error_type: checkerResult.error_type,
              expected,
              actual,
              diff,
              context: {
                raw_model_text: truncateText(rawModelText, 500),
                raw_model_text_full:
                  rawModelText.length > 500 ? rawModelText : undefined,
                parsed_tool_calls: mwParsedToolCalls.length
                  ? mwParsedToolCalls
                  : restoredCalls,
                expected_count: expectedCount,
                actual_count: Array.isArray(restoredCalls)
                  ? restoredCalls.length
                  : 0,
                finish_reason: finishReason,
                last_user_query: lastUserQuery,
                tool_names: tools.map((t) => t.name),
              },
            };

            caseLogs.push(`[DEBUG-FAIL] ${JSON.stringify(failurePayload)}`);
          } catch {
            caseLogs.push(`[DEBUG] ${testCase.id}: failed to build debug diff`);
          }
        };

        // Helper: Build tools map for AI SDK
        const buildToolsMap = (
          transformedTools: TransformedTool[]
        ): Record<string, ReturnType<typeof tool>> =>
          Object.fromEntries(
            transformedTools.map((t) => [
              t.name,
              tool({
                description:
                  typeof t.description === "string" ? t.description : undefined,
                inputSchema: jsonSchema(
                  t.inputSchema as Record<string, unknown>
                ),
              }),
            ])
          );

        // Helper: Execute model generation
        const executeModelGeneration = async (options: {
          model: LanguageModel;
          flatMessages: Message[];
          toolsMap: Record<string, ReturnType<typeof tool>>;
          temperature: number | undefined;
          maxTokens: number | undefined;
        }): Promise<{
          toolCalls: unknown;
          text: unknown;
          finishReason: unknown;
          debugSummaryRef: { originalText?: string; toolCalls?: string };
        }> => {
          const {
            model: modelInstance,
            flatMessages,
            toolsMap,
            temperature,
            maxTokens,
          } = options;

          const debugSummaryRef: {
            originalText?: string;
            toolCalls?: string;
          } = {};
          const providerOptions: Record<string, JSONObject> = {
            toolCallMiddleware: {
              debugSummary: debugSummaryRef,
            },
          };
          const { toolCalls, text, finishReason } = await generateText({
            model: modelInstance,
            messages: flatMessages as unknown as ModelMessage[],
            tools: toolsMap,
            toolChoice: "auto",
            providerOptions,
            ...(temperature !== undefined ? { temperature } : {}),
            ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
          });

          return { toolCalls, text, finishReason, debugSummaryRef };
        };

        // Helper: Process validation result
        const processValidationResult = (options: {
          checkerResult: {
            valid: boolean;
            error?: string;
            error_type?: string;
          };
          testCase: TestCase;
          tools: ToolSpec[];
          possibleAnswer: PossibleAnswer;
          restoredCalls: unknown[];
          flatMessages: Message[];
          mwOriginalText: string | undefined;
          text: unknown;
          finishReason: unknown;
          mwParsedToolCalls: Array<{ toolName?: string; input?: unknown }>;
          caseLogs: string[];
        }): { valid: boolean; logs: string[] } => {
          const {
            checkerResult,
            testCase,
            tools,
            possibleAnswer,
            restoredCalls,
            flatMessages,
            mwOriginalText,
            text,
            finishReason,
            mwParsedToolCalls,
            caseLogs,
          } = options;

          if (checkerResult.valid) {
            caseLogs.push(`[PASS] ${testCase.id}`);
            return { valid: true, logs: caseLogs };
          }

          caseLogs.push(`[FAIL] ${testCase.id}: ${checkerResult.error}`);
          logFailureDetails({
            testCase,
            tools,
            possibleAnswer,
            restoredCalls,
            checkerResult,
            flatMessages,
            mwOriginalText,
            text,
            finishReason,
            mwParsedToolCalls,
            caseLogs,
          });
          return { valid: false, logs: caseLogs };
        };

        // Helper: Prepare test case data
        const prepareTestCaseData = (
          testCase: TestCase
        ): {
          flatMessages: Message[];
          transformedTools: TransformedTool[];
          nameMap: Map<string, string>;
          toolsMap: Record<string, ReturnType<typeof tool>>;
        } => {
          const { function: tools, question: messages } = testCase;
          const flatMessages = flattenMessages(messages);
          const { transformedTools, nameMap } = buildTransformedTools(
            tools as ToolSpec[],
            fixSchema
          );
          const toolsMap = buildToolsMap(transformedTools);
          return { flatMessages, transformedTools, nameMap, toolsMap };
        };

        // Helper: Process model response
        const processModelResponse = (options: {
          testCase: TestCase;
          toolCalls: unknown;
          text: unknown;
          finishReason: unknown;
          debugSummaryRef: { originalText?: string; toolCalls?: string };
          nameMap: Map<string, string>;
          transformedTools: TransformedTool[];
          flatMessages: Message[];
          tools: ToolSpec[];
          caseLogs: string[];
        }): { valid: boolean; logs: string[] } => {
          const {
            testCase,
            toolCalls,
            text,
            finishReason,
            debugSummaryRef,
            nameMap,
            transformedTools,
            flatMessages,
            tools,
            caseLogs,
          } = options;

          const mwOriginalText: string | undefined =
            debugSummaryRef.originalText;
          const mwParsedToolCalls = parseDebugToolCalls(
            debugSummaryRef.toolCalls
          );

          const possibleAnswer = possibleAnswersMap.get(testCase.id);
          if (!possibleAnswer) {
            throw new Error(`No possible answer for id: ${testCase.id}`);
          }

          // Enhanced debug logging: compare expected vs actual
          if (process.env.DEBUG_PARSER_OUTPUT === "true") {
            // Render expected output in morphXML format
            const groundTruth = possibleAnswer.ground_truth as Record<
              string,
              unknown
            >[];
            const expectedXML = groundTruth
              .map((call) => convertGroundTruthToXML(call))
              .join("\n\n");

            console.log("\n========== BFCL CASE DEBUG ==========");
            console.log(`Test Case: ${testCase.id}`);
            console.log(`Expected count: ${groundTruth.length} call(s)`);
            console.log("\n--- EXPECTED OUTPUT (morphXML format) ---");
            console.log(expectedXML);
            console.log("\n--- ACTUAL MODEL OUTPUT (raw, with whitespace) ---");
            console.log(mwOriginalText || text || "(empty)");
            console.log(
              "\n--- PARSED TOOL CALLS (count: " +
                (Array.isArray(toolCalls) ? toolCalls.length : 0) +
                ") ---"
            );
            console.log(JSON.stringify(toolCalls, null, 2));
            console.log("======================================\n");
          }

          logRawToolCalls({
            toolCalls,
            finishReason,
            text,
            testCaseId: testCase.id,
            caseLogs,
          });

          const restoredCalls = restoreToolCalls(
            (toolCalls as unknown[]) || [],
            nameMap,
            transformedTools
          );

          const checkerResult = check(testCase, restoredCalls, possibleAnswer);

          return processValidationResult({
            checkerResult,
            testCase,
            tools,
            possibleAnswer,
            restoredCalls,
            flatMessages,
            mwOriginalText,
            text,
            finishReason,
            mwParsedToolCalls,
            caseLogs,
          });
        };

        // Per-test runner that does not throw and returns its own logs
        const runSingleCase = async (
          testCase: TestCase
        ): Promise<{ valid: boolean; logs: string[] }> => {
          const caseLogs: string[] = [];
          const { function: tools } = testCase;
          const temp = config?.temperature;
          const temperature = typeof temp === "number" ? temp : undefined;
          const maxTok = config?.maxTokens;
          const maxTokens = typeof maxTok === "number" ? maxTok : undefined;

          try {
            const { flatMessages, transformedTools, nameMap, toolsMap } =
              prepareTestCaseData(testCase);

            logFirstToolDebug(transformedTools, testCase.id, caseLogs);

            const { toolCalls, text, finishReason, debugSummaryRef } =
              await executeModelGeneration({
                model,
                flatMessages,
                toolsMap,
                temperature,
                maxTokens,
              });

            return processModelResponse({
              testCase,
              toolCalls,
              text,
              finishReason,
              debugSummaryRef,
              nameMap,
              transformedTools,
              flatMessages,
              tools: tools as ToolSpec[],
              caseLogs,
            });
          } catch (e: unknown) {
            caseLogs.push(
              `[ERROR] ${testCase.id}: Model generation failed: ${(e as Error)?.message}`
            );
            if ((e as Error)?.stack) {
              caseLogs.push(`[STACK] ${testCase.id}: ${(e as Error).stack}`);
            }
            return { valid: false, logs: caseLogs };
          }
        };

        // Generic concurrency mapper
        const mapWithConcurrency = async <T, R>(
          items: T[],
          concurrencyLimit: number,
          mapper: (item: T, index: number) => Promise<R>
        ): Promise<R[]> => {
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
                results[current] = await mapper(items[current], current);
              }
            });
          await Promise.all(workers);
          return results;
        };

        const resultsPerCase = await mapWithConcurrency(
          testCases,
          concurrency,
          async (tc) => runSingleCase(tc)
        );

        // Aggregate
        correctCount = resultsPerCase.reduce(
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
        const caseResults = resultsPerCase.map((r, i) => ({
          id: testCases[i].id,
          valid: r.valid,
        }));
        return {
          score,
          success: score > 0.95,
          metrics: {
            correct_count: correctCount,
            total_cases: testCases.length,
            accuracy: score,
            case_results: JSON.stringify(caseResults),
          },
          logs,
        };
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
export const bfclSimpleBenchmark = createBfclBenchmark(
  "bfcl-simple",
  "BFCL v4 Simple Function Calling",
  "BFCL_v4_simple.jsonl",
  "BFCL_v4_simple_possible_answer.jsonl"
);

export const bfclParallelBenchmark = createBfclBenchmark(
  "bfcl-parallel",
  "BFCL v4 Parallel Function Calling",
  "BFCL_v4_parallel.jsonl",
  "BFCL_v4_parallel_possible_answer.jsonl"
);

export const bfclMultipleBenchmark = createBfclBenchmark(
  "bfcl-multiple",
  "BFCL v4 Multiple Function Calling",
  "BFCL_v4_multiple.jsonl",
  "BFCL_v4_multiple_possible_answer.jsonl"
);

export const bfclParallelMultipleBenchmark = createBfclBenchmark(
  "bfcl-parallel-multiple",
  "BFCL v4 Parallel & Multiple Function Calling",
  "BFCL_v4_parallel_multiple.jsonl",
  "BFCL_v4_parallel_multiple_possible_answer.jsonl"
);
