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
import {
  executeMultiTurnFuncCall,
  globalMethodRegistry,
  multiTurnChecker,
  multiTurnIrrelevanceChecker,
  resetTestInstances,
  type ToolCall,
} from "../multi-turn";
import { resolveDataDir } from "../utils/paths";

const LINE_SPLIT_REGEX = /\r?\n/;
const NUMERIC_STRING_REGEX = /^\d+$/;
const MAXIMUM_STEP_LIMIT = 20;
const DEFAULT_USER_PROMPT_FOR_ADDITIONAL_FUNCTION_FC =
  "I have updated some more functions you can choose from. What about now?";

const MULTI_TURN_SYSTEM_PROMPT = `You are an expert in composing functions. You are given a question and a set of possible functions. Based on the question, you will need to make one or more function/tool calls to achieve the purpose. If none of the functions can be used, point it out. If the given question lacks the parameters required by the function, also point it out.

At each turn, you should try your best to complete the tasks requested by the user within the current turn. Continue to output functions to call until you have fulfilled the user's request to the best of your ability. Once you have no more functions to call, the system will consider the current turn complete and proceed to the next turn or task.`;

// Retry configuration for rate limit (429) errors
const RETRY_MAX_ATTEMPTS = 5;
const RETRY_INITIAL_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 60_000;
const RETRY_BACKOFF_MULTIPLIER = 2;

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

interface MultiTurnTestCase {
  id: string;
  question: Message[] | Message[][];
  initial_config?: Record<string, unknown>;
  path?: string[];
  involved_classes?: string[];
  missed_function?: Record<string, string[]>;
  excluded_function?: string[];
}

interface PossibleAnswer {
  id: string;
  ground_truth: string[][];
}

interface TransformedTool {
  type: "function";
  name: string;
  description?: string;
  inputSchema: ToolSchemaObject;
}

const MULTI_TURN_DATASETS = [
  {
    name: "bfcl-multi-turn-base",
    description: "BFCL v4 Multi-Turn Base Function Calling",
    testFile: "BFCL_v4_multi_turn_base.jsonl",
    answerFile: "possible_answer/BFCL_v4_multi_turn_base.jsonl",
  },
  {
    name: "bfcl-multi-turn-long-context",
    description: "BFCL v4 Multi-Turn Long-Context Function Calling",
    testFile: "BFCL_v4_multi_turn_long_context.jsonl",
    answerFile: "possible_answer/BFCL_v4_multi_turn_long_context.jsonl",
  },
  {
    name: "bfcl-multi-turn-miss-func",
    description: "BFCL v4 Multi-Turn Missing Function Calling",
    testFile: "BFCL_v4_multi_turn_miss_func.jsonl",
    answerFile: "possible_answer/BFCL_v4_multi_turn_miss_func.jsonl",
  },
  {
    name: "bfcl-multi-turn-miss-param",
    description: "BFCL v4 Multi-Turn Missing Parameter Function Calling",
    testFile: "BFCL_v4_multi_turn_miss_param.jsonl",
    answerFile: "possible_answer/BFCL_v4_multi_turn_miss_param.jsonl",
  },
] as const;

const MULTI_TURN_DOCS: Record<string, string> = {
  GorillaFileSystem: "multi_turn_func_doc/gorilla_file_system.jsonl",
  MathAPI: "multi_turn_func_doc/math_api.jsonl",
  MessageAPI: "multi_turn_func_doc/message_api.jsonl",
  TwitterAPI: "multi_turn_func_doc/posting_api.jsonl",
  TicketAPI: "multi_turn_func_doc/ticket_api.jsonl",
  TradingBot: "multi_turn_func_doc/trading_bot.jsonl",
  TravelAPI: "multi_turn_func_doc/travel_booking.jsonl",
  VehicleControlAPI: "multi_turn_func_doc/vehicle_control.jsonl",
};

const toolDocCache = new Map<string, ToolSpec[]>();

const normalizeTurns = (question: Message[] | Message[][]): Message[][] => {
  if (Array.isArray(question) && question.some((m) => Array.isArray(m))) {
    return question as Message[][];
  }
  return [question as Message[]];
};

const fixSchema = (schema: unknown): unknown => {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }
  const copy: ToolSchemaObject | unknown[] = Array.isArray(schema)
    ? (schema as unknown[]).map((v) => fixSchema(v))
    : ({ ...(schema as Record<string, unknown>) } as ToolSchemaObject);

  if (Array.isArray(copy)) {
    return copy;
  }

  if (!copy.type) {
    copy.type = "object";
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
  return copy;
};

const sanitizeName = (toolName: string): string => {
  const s = toolName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return s.length > 0 ? s : "tool";
};

const buildTransformedTools = (
  tools: ToolSpec[]
): { transformedTools: TransformedTool[]; nameMap: Map<string, string> } => {
  const nameMap = new Map<string, string>();
  const transformedTools = tools.map((t) => {
    const fixed = fixSchema(t.parameters);
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

const buildToolsMap = (
  transformedTools: TransformedTool[]
): Record<string, ReturnType<typeof tool>> =>
  Object.fromEntries(
    transformedTools.map((t) => [
      t.name,
      tool({
        description:
          typeof t.description === "string" ? t.description : undefined,
        inputSchema: jsonSchema(t.inputSchema as Record<string, unknown>),
      }),
    ])
  );

const parseToolArgs = (extractedArgs: unknown): unknown => {
  if (typeof extractedArgs !== "string") {
    return extractedArgs;
  }
  try {
    return JSON.parse(extractedArgs);
  } catch {
    // JSON.parse failed - might be due to unescaped control characters
    // (actual newlines/tabs instead of \n/\t escape sequences)
    try {
      const escaped = extractedArgs
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t");
      return JSON.parse(escaped);
    } catch {
      return extractedArgs;
    }
  }
};

const getSanitizedName = (
  rawName: unknown,
  transformedTools: TransformedTool[]
): unknown => {
  if (typeof rawName === "string" && NUMERIC_STRING_REGEX.test(rawName)) {
    return transformedTools[Number(rawName)]?.name ?? rawName;
  }
  return rawName;
};

const restoreToolCalls = (
  toolCalls: unknown[],
  nameMap: Map<string, string>,
  transformedTools: TransformedTool[]
): Array<{ toolCallId?: string; toolName: string; args: unknown }> =>
  (toolCalls || []).map((c: unknown) => {
    const call = c as Record<string, unknown>;
    const rawName = call.toolName ?? call.name;
    const sanitizedFromIndex = getSanitizedName(rawName, transformedTools);
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
      toolCallId:
        typeof call.toolCallId === "string" ? call.toolCallId : undefined,
      toolName: String(originalName),
      args: parsedArgs ?? {},
    };
  });

const loadToolsForClass = async (
  className: string,
  dataDir: string
): Promise<ToolSpec[]> => {
  // Force cache refresh if BFCL_FORCE_CACHE_REFRESH is set
  const forceRefresh = process.env.BFCL_FORCE_CACHE_REFRESH === "true";
  if (!forceRefresh) {
    const cached = toolDocCache.get(className);
    if (cached) {
      return cached;
    }
  }
  const relPath = MULTI_TURN_DOCS[className];
  if (!relPath) {
    throw new Error(`Missing tool doc mapping for class: ${className}`);
  }
  const raw = await fs.readFile(path.join(dataDir, relPath), "utf-8");
  const tools = raw
    .split(LINE_SPLIT_REGEX)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
    .map((entry: Record<string, unknown>) => {
      const methodName = typeof entry.name === "string" ? entry.name : "tool";
      // Use ClassName.methodName format to match Python BFCL implementation
      const fullName = `${className}.${methodName}`;
      return {
        name: fullName,
        description:
          typeof entry.description === "string" ? entry.description : undefined,
        parameters: (entry.parameters ?? {
          type: "object",
          properties: {},
        }) as ToolSchemaObject,
      } satisfies ToolSpec;
    });

  toolDocCache.set(className, tools);
  return tools;
};

const loadToolsForClasses = async (
  classes: string[],
  dataDir: string
): Promise<ToolSpec[]> => {
  const toolsPerClass = await Promise.all(
    classes.map((cls) => loadToolsForClass(cls, dataDir))
  );
  return toolsPerClass.flat();
};

const getMethodName = (toolName: string): string =>
  toolName.split(".").pop() ?? toolName;

const isRateLimitError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  if (message.includes("429") || message.includes("rate limit")) {
    return true;
  }
  const anyError = error as unknown as Record<string, unknown>;
  if (anyError.status === 429 || anyError.statusCode === 429) {
    return true;
  }
  // Check nested cause
  if (
    anyError.cause &&
    typeof anyError.cause === "object" &&
    (anyError.cause as Record<string, unknown>).status === 429
  ) {
    return true;
  }
  return false;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const withRetry = async <T>(
  fn: () => Promise<T>,
  options: { debug?: boolean } = {}
): Promise<T> => {
  let lastError: unknown;
  let delay = RETRY_INITIAL_DELAY_MS;

  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!isRateLimitError(error)) {
        throw error;
      }

      if (attempt === RETRY_MAX_ATTEMPTS) {
        throw error;
      }

      if (options.debug) {
        console.log(
          `[DEBUG] Rate limit hit, retrying in ${delay}ms (attempt ${attempt}/${RETRY_MAX_ATTEMPTS})`
        );
      }

      await sleep(delay);
      delay = Math.min(delay * RETRY_BACKOFF_MULTIPLIER, RETRY_MAX_DELAY_MS);
    }
  }

  throw lastError;
};

const createBfclMultiTurnBenchmark = (
  name: string,
  description: string,
  testDataFile: string,
  answerDataFile: string
): LanguageModelV3Benchmark => ({
  name,
  version: "1.0.0",
  description,
  async run(
    model: LanguageModel,
    config?: Record<string, unknown>
  ): Promise<BenchmarkResult> {
    console.log("Starting BFCL multi-turn benchmark...");

    // Clear tool cache on each run to ensure fresh execution
    toolDocCache.clear();

    // Also clear method registry instances to ensure fresh state
    globalMethodRegistry.reset();

    const logs: string[] = [];
    let correctCount = 0;
    let testCases: MultiTurnTestCase[] = [];

    const dataPath = resolveDataDir();
    // Include config in runId to ensure different cache for different settings
    const configHash = JSON.stringify(config || {});
    const runId = `bfcl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${configHash.slice(0, 10)}`;

    try {
      logs.push(`[INFO] Using data dir: ${dataPath}`);
      const testCasesJson = await fs.readFile(
        path.join(dataPath, testDataFile),
        "utf-8"
      );
      const possibleAnswersJson = await fs.readFile(
        path.join(dataPath, answerDataFile),
        "utf-8"
      );

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

      const limitEnv = process.env.BFCL_LIMIT;
      const limit = limitEnv ? Number(limitEnv) : undefined;
      if (limit && Number.isFinite(limit) && limit > 0) {
        testCases = testCases.slice(0, limit);
        logs.push(`[INFO] Limiting test cases to ${limit} due to BFCL_LIMIT.`);
      }

      const concurrencyEnv = process.env.BFCL_CONCURRENCY;
      const concurrency =
        concurrencyEnv && Number.isFinite(Number(concurrencyEnv))
          ? Math.max(1, Number(concurrencyEnv))
          : 4;
      logs.push(
        `[INFO] Running ${testCases.length} test cases with concurrency=${concurrency}`
      );

      const temp = config?.temperature;
      const temperature = typeof temp === "number" ? temp : undefined;
      const maxTok = config?.maxTokens;
      const maxTokens = typeof maxTok === "number" ? maxTok : undefined;
      const externalProviderOptions = config?.providerOptions as
        | Record<string, Record<string, unknown>>
        | undefined;

      const debugMode = process.env.BFCL_DEBUG === "true";

      const executeModelGeneration = async (options: {
        messages: ModelMessage[];
        toolsMap: Record<string, ReturnType<typeof tool>>;
      }): Promise<{
        toolCalls: unknown;
        text: unknown;
        finishReason: unknown;
      }> => {
        const { messages, toolsMap } = options;
        const internalProviderOptions: Record<string, JSONObject> = {
          toolCallMiddleware: {
            debugSummary: {},
          },
        };
        const mergedProviderOptions: Record<string, JSONObject> = {
          ...(externalProviderOptions as Record<string, JSONObject>),
          ...internalProviderOptions,
        };
        const { toolCalls, text, finishReason } = await withRetry(
          () =>
            generateText({
              model,
              system: MULTI_TURN_SYSTEM_PROMPT,
              messages,
              tools: toolsMap,
              toolChoice: "auto",
              providerOptions: mergedProviderOptions,
              ...(temperature !== undefined ? { temperature } : {}),
              ...(maxTokens !== undefined
                ? { maxOutputTokens: maxTokens }
                : {}),
            }),
          { debug: debugMode }
        );

        if (debugMode) {
          console.log("[DEBUG] generateText response:");
          console.log("  finishReason:", finishReason);
          console.log("  text:", text?.slice?.(0, 200) ?? text);
          console.log(
            "  toolCalls:",
            JSON.stringify(toolCalls, null, 2)?.slice(0, 500)
          );
        }

        return { toolCalls, text, finishReason };
      };

      const buildWithholdUntil = (
        missedFunctionMap: Record<string, string[]>
      ): Map<string, number> => {
        const withholdUntil = new Map<string, number>();
        for (const [turnStr, funcs] of Object.entries(missedFunctionMap)) {
          const turnIndex = Number(turnStr);
          if (!Number.isFinite(turnIndex)) {
            continue;
          }
          for (const fn of funcs) {
            withholdUntil.set(fn, turnIndex);
          }
        }
        return withholdUntil;
      };

      const getTurnMessages = (
        turns: Message[][],
        turnIndex: number,
        missedFunctionMap: Record<string, string[]>
      ): Message[] => {
        const turnMessages = turns[turnIndex] ?? [];
        const missedFunctionsForTurn =
          missedFunctionMap[String(turnIndex)] ?? [];
        if (turnMessages.length === 0 && missedFunctionsForTurn.length > 0) {
          return [
            {
              role: "user",
              content: DEFAULT_USER_PROMPT_FOR_ADDITIONAL_FUNCTION_FC,
            },
          ];
        }
        return turnMessages;
      };

      const getAvailableTools = (
        tools: ToolSpec[],
        excludedFunctions: Set<string>,
        withholdUntil: Map<string, number>,
        turnIndex: number
      ): ToolSpec[] =>
        tools.filter((toolSpec) => {
          const methodName = getMethodName(toolSpec.name);
          if (
            excludedFunctions.has(methodName) ||
            excludedFunctions.has(toolSpec.name)
          ) {
            return false;
          }
          const availableFrom =
            withholdUntil.get(methodName) ?? withholdUntil.get(toolSpec.name);
          if (availableFrom !== undefined && turnIndex < availableFrom) {
            return false;
          }
          return true;
        });

      const runToolStep = async (options: {
        history: ModelMessage[];
        toolsMap: Record<string, ReturnType<typeof tool>>;
        transformedTools: TransformedTool[];
        nameMap: Map<string, string>;
        turnIndex: number;
        stepCount: number;
        initialConfig: Record<string, unknown>;
        involvedClasses: string[];
        isLongContext: boolean;
        testCaseId: string;
      }): Promise<{
        done: boolean;
        history: ModelMessage[];
        toolCalls: ToolCall[];
      }> => {
        const {
          history,
          toolsMap,
          transformedTools,
          nameMap,
          turnIndex,
          stepCount,
          initialConfig,
          involvedClasses,
          isLongContext,
          testCaseId,
        } = options;

        const { toolCalls, text, finishReason } = await executeModelGeneration({
          messages: history,
          toolsMap,
        });
        const toolCallsArray = Array.isArray(toolCalls) ? toolCalls : [];

        console.log(`[DEBUG] TestCase ${testCaseId} Step ${stepCount}:`);
        console.log(`  History length: ${history.length}`);
        console.log("  Last message:", history.at(-1));
        console.log(`  Finish reason: ${finishReason}`);
        console.log(`  Text response: "${text}"`);
        console.log(`  Tool calls count: ${toolCallsArray.length}`);
        if (toolCallsArray.length > 0) {
          console.log(
            "  Tool calls:",
            toolCallsArray.map((tc) => ({
              name: tc.toolName,
              args: tc.args,
            }))
          );
        }

        // Model finished without tool calls - turn is complete
        // Add assistant text response to history (matching official BFCL behavior)
        if (toolCallsArray.length === 0) {
          const textContent = typeof text === "string" ? text : "";
          const updatedHistory: ModelMessage[] = textContent
            ? [
                ...history,
                {
                  role: "assistant",
                  content: [{ type: "text", text: textContent }],
                },
              ]
            : history;
          return { done: true, history: updatedHistory, toolCalls: [] };
        }

        // If finishReason indicates stop (not tool_calls), treat as done after this execution
        // This handles models that return both text and tool calls but signal completion
        const isLastStep =
          finishReason === "stop" ||
          finishReason === "end_turn" ||
          finishReason === "length";

        const restoredCalls = restoreToolCalls(
          toolCallsArray,
          nameMap,
          transformedTools
        );

        const toolCallParts = toolCallsArray.map((call, idx) => {
          const record = call as Record<string, unknown>;
          const toolCallId =
            typeof record.toolCallId === "string"
              ? record.toolCallId
              : `toolcall-${turnIndex}-${stepCount}-${idx}`;
          const rawName = record.toolName ?? record.name;
          const toolName =
            typeof rawName === "string"
              ? rawName
              : (transformedTools[idx]?.name ?? "tool");
          const extractedArgs =
            record.args ??
            record.arguments ??
            record.input ??
            record.params ??
            record.parameters;
          const parsedInput = parseToolArgs(extractedArgs) ?? {};

          if (debugMode) {
            console.log(`[DEBUG] Tool call ${idx} args processing:`);
            console.log(`  record.args type: ${typeof record.args}`);
            console.log(`  record.arguments type: ${typeof record.arguments}`);
            console.log(
              `  extractedArgs type: ${typeof extractedArgs}, value: ${JSON.stringify(extractedArgs)?.slice(0, 200)}`
            );
            console.log(
              `  parsedInput type: ${typeof parsedInput}, value: ${JSON.stringify(parsedInput)?.slice(0, 200)}`
            );
          }

          return {
            type: "tool-call" as const,
            toolCallId,
            toolName,
            input: parsedInput,
          };
        });

        const historyWithToolCalls: ModelMessage[] = [
          ...history,
          {
            role: "assistant",
            content: toolCallParts,
          },
        ];

        const toolCallsForExecution: ToolCall[] = restoredCalls.map((call) => ({
          toolName: call.toolName,
          args: (call.args ?? {}) as Record<string, unknown>,
        }));

        const executionResult = await executeMultiTurnFuncCall(
          toolCallsForExecution,
          initialConfig,
          involvedClasses,
          runId,
          testCaseId,
          isLongContext,
          false
        );
        const executionResults = executionResult.executionResults;

        console.log("[DEBUG] Tool call execution results:", executionResults);
        console.log("[DEBUG] Tool calls:", toolCallsForExecution);

        const toolResultParts = executionResults.map((result, idx) => {
          const toolCallPart = toolCallParts[idx];
          return {
            type: "tool-result" as const,
            toolCallId: toolCallPart.toolCallId,
            toolName: toolCallPart.toolName,
            output: {
              type: "text" as const,
              value: result,
            },
          };
        });

        const historyWithToolResults: ModelMessage[] = [
          ...historyWithToolCalls,
          {
            role: "tool",
            content: toolResultParts,
          },
        ];

        return {
          done: isLastStep,
          history: historyWithToolResults,
          toolCalls: toolCallsForExecution,
        };
      };

      const runTurn = async (options: {
        testCase: MultiTurnTestCase;
        turnIndex: number;
        history: ModelMessage[];
        tools: ToolSpec[];
        excludedFunctions: Set<string>;
        withholdUntil: Map<string, number>;
        initialConfig: Record<string, unknown>;
        involvedClasses: string[];
        isLongContext: boolean;
      }): Promise<{
        history: ModelMessage[];
        turnResults: ToolCall[][];
        forceQuit: boolean;
      }> => {
        const {
          testCase,
          turnIndex,
          history,
          tools,
          excludedFunctions,
          withholdUntil,
          initialConfig,
          involvedClasses,
          isLongContext,
        } = options;
        const availableTools = getAvailableTools(
          tools,
          excludedFunctions,
          withholdUntil,
          turnIndex
        );
        const { transformedTools, nameMap } =
          buildTransformedTools(availableTools);
        const toolsMap = buildToolsMap(transformedTools);
        const turnResults: ToolCall[][] = [];
        let stepCount = 0;
        let updatedHistory = history;

        while (stepCount <= MAXIMUM_STEP_LIMIT) {
          const stepResult = await runToolStep({
            history: updatedHistory,
            toolsMap,
            transformedTools,
            nameMap,
            turnIndex,
            stepCount,
            initialConfig,
            involvedClasses,
            isLongContext,
            testCaseId: testCase.id,
          });
          if (stepResult.done) {
            return {
              history: stepResult.history,
              turnResults,
              forceQuit: false,
            };
          }
          turnResults.push(stepResult.toolCalls);
          updatedHistory = stepResult.history;
          stepCount += 1;
        }

        return { history: updatedHistory, turnResults, forceQuit: true };
      };

      const buildCaseContext = async (
        testCase: MultiTurnTestCase,
        possibleAnswer: PossibleAnswer
      ): Promise<{
        turns: Message[][];
        expectedGroundTruth: string[][];
        involvedClasses: string[];
        initialConfig: Record<string, unknown>;
        excludedFunctions: Set<string>;
        missedFunctionMap: Record<string, string[]>;
        tools: ToolSpec[];
        withholdUntil: Map<string, number>;
        isLongContext: boolean;
      }> => {
        const turns = normalizeTurns(testCase.question ?? []);
        const expectedGroundTruth = possibleAnswer.ground_truth;
        const involvedClasses = testCase.involved_classes ?? [];
        const initialConfig = testCase.initial_config ?? {};
        const excludedFunctions = new Set(testCase.excluded_function ?? []);
        const missedFunctionMap = testCase.missed_function ?? {};
        const tools = await loadToolsForClasses(involvedClasses, dataPath);
        const withholdUntil = buildWithholdUntil(missedFunctionMap);
        const isLongContext =
          testCase.id.includes("long_context") ||
          testCase.id.includes("composite");
        return {
          turns,
          expectedGroundTruth,
          involvedClasses,
          initialConfig,
          excludedFunctions,
          missedFunctionMap,
          tools,
          withholdUntil,
          isLongContext,
        };
      };

      const runConversation = async (context: {
        turns: Message[][];
        testCase: MultiTurnTestCase;
        tools: ToolSpec[];
        excludedFunctions: Set<string>;
        withholdUntil: Map<string, number>;
        initialConfig: Record<string, unknown>;
        involvedClasses: string[];
        missedFunctionMap: Record<string, string[]>;
        isLongContext: boolean;
      }): Promise<{
        modelResultsByTurn: ToolCall[][][];
        forceQuit: boolean;
      }> => {
        const {
          turns,
          testCase,
          tools,
          excludedFunctions,
          withholdUntil,
          initialConfig,
          involvedClasses,
          missedFunctionMap,
          isLongContext,
        } = context;
        let history: ModelMessage[] = [];
        const modelResultsByTurn: ToolCall[][][] = [];

        for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
          const turnMessages = getTurnMessages(
            turns,
            turnIndex,
            missedFunctionMap
          );
          if (turnMessages.length > 0) {
            history = [
              ...history,
              ...(turnMessages as unknown as ModelMessage[]),
            ];
          }

          const turnOutcome = await runTurn({
            testCase,
            turnIndex,
            history,
            tools,
            excludedFunctions,
            withholdUntil,
            initialConfig,
            involvedClasses,
            isLongContext,
          });

          history = turnOutcome.history;
          modelResultsByTurn.push(turnOutcome.turnResults);

          if (turnOutcome.forceQuit) {
            return { modelResultsByTurn, forceQuit: true };
          }
        }

        return { modelResultsByTurn, forceQuit: false };
      };

      const checkCase = async (
        testCase: MultiTurnTestCase,
        modelResultsByTurn: ToolCall[][][],
        expectedGroundTruth: string[][]
      ): Promise<Record<string, unknown>> => {
        const testCategory = testCase.id.split("_").slice(0, -1).join("_");
        const checkResult = await multiTurnChecker(
          modelResultsByTurn,
          expectedGroundTruth,
          testCase,
          testCategory,
          runId
        );

        // Also check irrelevance
        const irrelevanceResult = multiTurnIrrelevanceChecker(
          modelResultsByTurn,
          expectedGroundTruth
        );

        return {
          valid: checkResult.valid && irrelevanceResult.valid,
          error_type: checkResult.error_type || irrelevanceResult.error_type,
          details: checkResult.details || irrelevanceResult.details,
        };
      };

      const runSingleCase = async (
        testCase: MultiTurnTestCase
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Multi-turn evaluation requires complex branching
      ): Promise<{ valid: boolean; logs: string[] }> => {
        try {
          const caseLogs: string[] = [];
          const possibleAnswer = possibleAnswersMap.get(testCase.id);
          if (!possibleAnswer) {
            caseLogs.push(`[FAIL] ${testCase.id}: missing possible answer`);
            return { valid: false, logs: caseLogs };
          }

          const context = await buildCaseContext(testCase, possibleAnswer);

          const conversationResult = await runConversation({
            ...context,
            testCase,
          });
          if (conversationResult.forceQuit) {
            caseLogs.push(
              `[FAIL] ${testCase.id}: force-terminated after ${MAXIMUM_STEP_LIMIT} steps`
            );
            return { valid: false, logs: caseLogs };
          }

          const checkerResult = await checkCase(
            testCase,
            conversationResult.modelResultsByTurn,
            context.expectedGroundTruth
          );

          // Always log for debugging
          console.log(`[DEBUG] Test case: ${testCase.id}`);
          console.log(
            `[DEBUG] Model results (${conversationResult.modelResultsByTurn.length} turns):`,
            conversationResult.modelResultsByTurn
          );
          console.log(
            `[DEBUG] Ground truth (${context.expectedGroundTruth.length} turns):`,
            context.expectedGroundTruth
          );

          // Compare results in detail
          for (
            let turn = 0;
            turn <
            Math.max(
              conversationResult.modelResultsByTurn.length,
              context.expectedGroundTruth.length
            );
            turn++
          ) {
            const modelTurn = conversationResult.modelResultsByTurn[turn] || [];
            const gtTurn = context.expectedGroundTruth[turn] || [];
            console.log(`[DEBUG] Turn ${turn}:`);
            console.log(`  Model: ${JSON.stringify(modelTurn)}`);
            console.log(`  Ground Truth: ${JSON.stringify(gtTurn)}`);
            console.log(
              `  Match: ${JSON.stringify(modelTurn) === JSON.stringify(gtTurn)}`
            );
          }

          console.log("[DEBUG] Checker result:", checkerResult);
          console.log(
            `[DEBUG] Ground truth (${context.expectedGroundTruth.length} turns):`,
            context.expectedGroundTruth
          );
          console.log("[DEBUG] Checker result:", checkerResult);

          if (checkerResult.valid === true) {
            caseLogs.push(`[PASS] ${testCase.id}`);
            return { valid: true, logs: caseLogs };
          }

          caseLogs.push(
            `[FAIL] ${testCase.id}: ${checkerResult.error_type ?? "unknown error"}`
          );
          return { valid: false, logs: caseLogs };
        } catch (e: unknown) {
          const errorMsg =
            e instanceof Error ? e.message : "unknown error in runSingleCase";
          return {
            valid: false,
            logs: [`[FAIL] ${testCase.id}: ${errorMsg}`],
          };
        }
      };

      const runSingleCaseSafe = async (
        testCase: MultiTurnTestCase
      ): Promise<{ valid: boolean; logs: string[] }> => {
        try {
          return await runSingleCase(testCase);
        } catch (e: unknown) {
          const errorMsg =
            e instanceof Error ? e.message : "unknown error occurred";
          if (debugMode) {
            console.error(`[DEBUG] Error in test case ${testCase.id}:`, e);
          }
          return {
            valid: false,
            logs: [`[FAIL] ${testCase.id}: ${errorMsg}`],
          };
        }
      };

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
        async (tc) => runSingleCaseSafe(tc)
      );

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
          `[ERROR] Failed to run BFCL multi-turn benchmark: ${(e as Error).message}`,
        ],
      };
    } finally {
      // Clean up test instances
      resetTestInstances("", runId);
    }
  },
});

export const bfclMultiTurnBaseBenchmark = createBfclMultiTurnBenchmark(
  MULTI_TURN_DATASETS[0].name,
  MULTI_TURN_DATASETS[0].description,
  MULTI_TURN_DATASETS[0].testFile,
  MULTI_TURN_DATASETS[0].answerFile
);
export const bfclMultiTurnLongContextBenchmark = createBfclMultiTurnBenchmark(
  MULTI_TURN_DATASETS[1].name,
  MULTI_TURN_DATASETS[1].description,
  MULTI_TURN_DATASETS[1].testFile,
  MULTI_TURN_DATASETS[1].answerFile
);
export const bfclMultiTurnMissFuncBenchmark = createBfclMultiTurnBenchmark(
  MULTI_TURN_DATASETS[2].name,
  MULTI_TURN_DATASETS[2].description,
  MULTI_TURN_DATASETS[2].testFile,
  MULTI_TURN_DATASETS[2].answerFile
);
export const bfclMultiTurnMissParamBenchmark = createBfclMultiTurnBenchmark(
  MULTI_TURN_DATASETS[3].name,
  MULTI_TURN_DATASETS[3].description,
  MULTI_TURN_DATASETS[3].testFile,
  MULTI_TURN_DATASETS[3].answerFile
);
