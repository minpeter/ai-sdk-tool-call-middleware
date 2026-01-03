import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
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

const LINE_SPLIT_REGEX = /\r?\n/;
const NUMERIC_STRING_REGEX = /^\d+$/;
const MAXIMUM_STEP_LIMIT = 20;
const DEFAULT_USER_PROMPT_FOR_ADDITIONAL_FUNCTION_FC =
  "I have updated some more functions you can choose from. What about now?";

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

class PythonRunner {
  private readonly proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 0;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();

  constructor(dataDir: string) {
    const runnerPath = path.join(dataDir, "bfcl_eval", "runner.py");
    this.proc = spawn("python3", ["-u", runnerPath], {
      env: {
        ...process.env,
        PYTHONPATH: dataDir,
      },
      stdio: "pipe",
    });

    this.proc.stdout.setEncoding("utf-8");
    this.proc.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx = this.buffer.indexOf("\n");
      while (idx >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line.length > 0) {
          this.handleLine(line);
        }
        idx = this.buffer.indexOf("\n");
      }
    });

    this.proc.stderr.on("data", (chunk) => {
      // Surface stderr as a rejected promise if any pending request exists.
      const message = chunk.toString();
      for (const { reject } of this.pending.values()) {
        reject(new Error(message));
      }
      this.pending.clear();
    });

    this.proc.on("exit", (code) => {
      const err = new Error(`Python runner exited with code ${code}`);
      for (const { reject } of this.pending.values()) {
        reject(err);
      }
      this.pending.clear();
    });
  }

  private handleLine(line: string) {
    try {
      const payload = JSON.parse(line) as { id?: string; error?: string };
      if (!payload.id) {
        return;
      }
      const pending = this.pending.get(payload.id);
      if (!pending) {
        return;
      }
      this.pending.delete(payload.id);
      if (payload.error) {
        pending.reject(new Error(payload.error));
      } else {
        pending.resolve(payload);
      }
    } catch (err) {
      for (const { reject } of this.pending.values()) {
        reject(err as Error);
      }
      this.pending.clear();
    }
  }

  private request<
    T extends Record<string, unknown>,
    R = Record<string, unknown>,
  >(action: string, payload: T): Promise<R> {
    const id = `req_${this.nextId++}`;
    const message = JSON.stringify({ id, action, ...payload });
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(`${message}\n`);
    }) as Promise<R>;
  }

  async execute(payload: {
    func_call_list: string[];
    initial_config: Record<string, unknown>;
    involved_classes: string[];
    model_name: string;
    test_entry_id: string;
    long_context: boolean;
    is_eval_run: boolean;
  }): Promise<string[]> {
    const response = await this.request("execute", payload);
    return (response.results as string[]) ?? [];
  }

  async check(payload: {
    model_results: string[][][];
    ground_truth: string[][];
    test_entry: Record<string, unknown>;
    test_category: string;
    model_name: string;
  }): Promise<Record<string, unknown>> {
    const response = await this.request("check", payload);
    return (response.result as Record<string, unknown>) ?? {};
  }

  async reset(payload: {
    model_name: string;
    test_entry_id: string;
  }): Promise<void> {
    await this.request("reset", payload);
  }

  close() {
    this.proc.kill();
  }
}

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
    return extractedArgs;
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

const toPythonLiteral = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "None";
  }
  if (typeof value === "string") {
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return `'${escaped}'`;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => toPythonLiteral(v)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `'${k}': ${toPythonLiteral(v)}`
    );
    return `{${entries.join(", ")}}`;
  }
  return String(value);
};

const buildPythonCall = (toolName: string, args: unknown): string => {
  const methodName = toolName.split(".").pop() ?? toolName;
  if (args == null) {
    return `${methodName}()`;
  }
  if (typeof args !== "object" || Array.isArray(args)) {
    return `${methodName}(${toPythonLiteral(args)})`;
  }
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) {
    return `${methodName}()`;
  }
  const formatted = entries
    .map(([k, v]) => `${k}=${toPythonLiteral(v)}`)
    .join(", ");
  return `${methodName}(${formatted})`;
};

const loadToolsForClass = async (
  className: string,
  dataDir: string
): Promise<ToolSpec[]> => {
  const cached = toolDocCache.get(className);
  if (cached) {
    return cached;
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
      const name = typeof entry.name === "string" ? entry.name : "tool";
      return {
        name,
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
    const logs: string[] = [];
    let correctCount = 0;
    let testCases: MultiTurnTestCase[] = [];

    const dataPath = resolveDataDir();
    const pythonRunner = new PythonRunner(dataPath);
    const runId = `bfcl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

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
        const providerOptions: Record<string, JSONObject> = {
          toolCallMiddleware: {
            debugSummary: {},
          },
        };
        const { toolCalls, text, finishReason } = await generateText({
          model,
          messages,
          tools: toolsMap,
          toolChoice: "auto",
          providerOptions,
          ...(temperature !== undefined ? { temperature } : {}),
          ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
        });

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
        callStrings: string[];
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

        if (debugMode) {
          console.log(
            `[DEBUG] Step ${stepCount}: finishReason=${finishReason}, toolCalls.length=${toolCallsArray.length}`
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
          return { done: true, history: updatedHistory, callStrings: [] };
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
          return {
            type: "tool-call" as const,
            toolCallId,
            toolName,
            input: parseToolArgs(extractedArgs) ?? {},
          };
        });

        const historyWithToolCalls: ModelMessage[] = [
          ...history,
          {
            role: "assistant",
            content: toolCallParts,
          },
        ];

        const pythonCallStrings = restoredCalls.map((call) =>
          buildPythonCall(call.toolName, call.args)
        );

        const executionResults = await pythonRunner.execute({
          func_call_list: pythonCallStrings,
          initial_config: initialConfig,
          involved_classes: involvedClasses,
          model_name: runId,
          test_entry_id: testCaseId,
          long_context: isLongContext,
          is_eval_run: false,
        });

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
          callStrings: pythonCallStrings,
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
        turnResults: string[][];
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
        const turnResults: string[][] = [];
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
          turnResults.push(stepResult.callStrings);
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
        modelResultsByTurn: string[][][];
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
        const modelResultsByTurn: string[][][] = [];

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
        modelResultsByTurn: string[][][],
        expectedGroundTruth: string[][]
      ): Promise<Record<string, unknown>> =>
        pythonRunner.check({
          model_results: modelResultsByTurn,
          ground_truth: expectedGroundTruth,
          test_entry: testCase as unknown as Record<string, unknown>,
          test_category: testCase.id.split("_").slice(0, -1).join("_"),
          model_name: runId,
        });

      const runSingleCase = async (
        testCase: MultiTurnTestCase
      ): Promise<{ valid: boolean; logs: string[] }> => {
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

        if (debugMode) {
          console.log(`[DEBUG] Test case: ${testCase.id}`);
          console.log(
            `[DEBUG] Model results (${conversationResult.modelResultsByTurn.length} turns):`
          );
          conversationResult.modelResultsByTurn.forEach((turn, i) => {
            console.log(`  Turn ${i}: ${JSON.stringify(turn)}`);
          });
          console.log(
            `[DEBUG] Ground truth (${context.expectedGroundTruth.length} turns):`
          );
          context.expectedGroundTruth.forEach((turn, i) => {
            console.log(`  Turn ${i}: ${JSON.stringify(turn)}`);
          });
          console.log(
            "[DEBUG] Checker result:",
            JSON.stringify(checkerResult, null, 2)
          );
        }

        if (checkerResult.valid === true) {
          caseLogs.push(`[PASS] ${testCase.id}`);
          return { valid: true, logs: caseLogs };
        }

        caseLogs.push(
          `[FAIL] ${testCase.id}: ${checkerResult.error_message ?? "unknown error"}`
        );
        return { valid: false, logs: caseLogs };
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
      pythonRunner.close();
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
