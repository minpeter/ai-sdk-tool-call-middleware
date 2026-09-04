import { appendFileSync } from "node:fs";
import type { LanguageModelV4Middleware } from "@ai-sdk/provider";
import { jsonSchema, type ToolSet } from "ai";
import { runBenchmarkModel } from "./benchmark-model-call";
import {
  type CapturedFunctionTool,
  credentialSafeError,
  type ProviderCapture,
} from "./provider-capture";

export type ArmId =
  | "native"
  | "glm5"
  | "hermes"
  | "morphXml"
  | "yamlXml"
  | "qwen3Coder"
  | "sijawaraDetailed"
  | "sijawaraConcise"
  | "uiTars";

export interface Arm {
  readonly id: ArmId;
  readonly middleware?: LanguageModelV4Middleware;
}

interface AceFunction {
  readonly _arguments?: Record<string, unknown>;
  readonly arguments?: Record<string, unknown>;
  readonly description?: string;
  readonly name: string;
  readonly parameters?: Record<string, unknown>;
}

export type Language = "en" | "zh";
export type Category =
  | "normal_single_turn_single_function"
  | "normal_single_turn_parallel_function"
  | "normal_similar_api"
  | "normal_preference"
  | "normal_atom_bool"
  | "normal_atom_enum"
  | "normal_atom_number"
  | "normal_atom_list"
  | "normal_atom_object_deep"
  | "normal_atom_object_short";

export interface AceCase {
  readonly category: Category;
  readonly function: AceFunction[];
  readonly id: string;
  readonly language: Language;
  readonly profile?: string;
  readonly question: string;
  readonly time?: string;
}

interface NameMap {
  readonly original: string;
  readonly safe: string;
}

export interface RunResult {
  readonly arm: ArmId;
  readonly attempts: number;
  readonly calls: Array<{ arguments: unknown; name: string }>;
  readonly caseId: string;
  readonly category: Category;
  readonly error?: string;
  readonly finishReason?: string;
  readonly language: Language;
  readonly latencyMs: number;
  readonly model: string;
  readonly nameMap: NameMap[];
  readonly parserErrors: string[];
  readonly rawCaptureIds: string[];
  readonly rawFinishReason?: string;
  readonly text: string;
  readonly textLeak: boolean;
  readonly transport: "generate" | "stream";
  readonly transportOk: boolean;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
  };
}

export interface Job {
  readonly arm: Arm;
  readonly testCase: AceCase;
}

interface ExecutionOptions {
  readonly batches: readonly (readonly Job[])[];
  readonly benchmarkTransport: "generate" | "stream";
  readonly capture: ProviderCapture;
  readonly initialCompletedJobs: number;
  readonly modelForArm: (
    arm: Arm
  ) => Parameters<typeof runBenchmarkModel>[0]["model"];
  readonly modelId: string;
  readonly outputPath: string;
  readonly requestTimeoutMs: number;
  readonly retryLimit: number;
  readonly secretApiKey: string;
  readonly totalJobs: number;
  readonly workerConcurrency: number;
}

const COMMON_INSTRUCTION =
  "You are a precise function-calling assistant. Follow the user request exactly. " +
  "Call only relevant tools, and do not invent a tool call when none applies.";
const LEAK_PATTERNS = [
  "<tool_call",
  "</tool_call",
  "<function=",
  "</function>",
  "<tools>",
  "[TOOL_CALLS]",
  "<|tool_call",
];
const FUNCTION_NAME_UNSAFE_PATTERN = /[^a-zA-Z0-9_-]/g;
const FUNCTION_NAME_LEADING_UNDERSCORE_PATTERN = /^_+/;
const RETRYABLE_ERROR_PATTERN =
  /(?:429|5\d\d|aborted|bad gateway|credit limit|fetch failed|gateway timeout|internal server error|rate limit|service unavailable|suspended|temporarily unavailable|timeout)/i;

function safeFunctionNames(functions: AceFunction[]): NameMap[] {
  const used = new Set<string>();
  const names: NameMap[] = [];
  for (const [index, definition] of functions.entries()) {
    const stem =
      definition.name
        .replace(FUNCTION_NAME_UNSAFE_PATTERN, "_")
        .replace(FUNCTION_NAME_LEADING_UNDERSCORE_PATTERN, "")
        .slice(0, 56) || `function_${index}`;
    let safe = stem;
    let suffix = 2;
    while (used.has(safe)) {
      safe = `${stem.slice(0, 52)}_${suffix}`;
      suffix += 1;
    }
    used.add(safe);
    names.push({ original: definition.name, safe });
  }
  return names;
}

function normalizeType(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeType);
  }
  const mapping: Record<string, string | undefined> = {
    bool: "boolean",
    dict: "object",
    float: "number",
    list: "array",
  };
  return typeof value === "string" && value in mapping ? mapping[value] : value;
}

function normalizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeSchema);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const schema = value as Record<string, unknown>;
  const result: Record<string, unknown> = { ...schema };
  result.unit = undefined;
  if (schema.type !== undefined) {
    result.type = normalizeType(schema.type);
  }
  if (
    schema.properties &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
  ) {
    result.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, child]) => [
        key,
        normalizeSchema(child),
      ])
    );
  }
  if (Array.isArray(schema.items)) {
    result.items = schema.items.map(normalizeSchema);
  } else if (schema.items && typeof schema.items === "object") {
    result.items = normalizeSchema(schema.items);
  }
  if (
    schema.additionalProperties &&
    typeof schema.additionalProperties === "object"
  ) {
    result.additionalProperties = normalizeSchema(schema.additionalProperties);
  }
  for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    const alternatives = schema[keyword];
    if (Array.isArray(alternatives)) {
      result[keyword] = alternatives.map(normalizeSchema);
    }
  }
  if (result.type === "array" && result.items === undefined) {
    result.items = {};
  }
  if (result.type === "object" && result.properties === undefined) {
    result.additionalProperties = true;
  }
  return result;
}

function makeTools(testCase: AceCase, nameMap: NameMap[]): ToolSet {
  return Object.fromEntries(
    testCase.function.map((definition, index) => {
      const schema = definition.parameters ??
        definition.arguments ??
        definition._arguments ?? { properties: {}, type: "object" };
      return [
        nameMap[index].safe,
        {
          description: definition.description,
          inputSchema: jsonSchema(
            normalizeSchema(schema) as Record<string, unknown>
          ),
        },
      ];
    })
  );
}

function capturedTools(
  testCase: AceCase,
  nameMap: NameMap[]
): CapturedFunctionTool[] {
  return testCase.function.map((definition, index) => {
    const schema = definition.parameters ??
      definition.arguments ??
      definition._arguments ?? { properties: {}, type: "object" };
    return {
      description: definition.description,
      inputSchema: normalizeSchema(schema),
      name: nameMap[index].safe,
      originalName: nameMap[index].original,
    };
  });
}

function makeInstructions(testCase: AceCase): string {
  const context: string[] = [];
  const time = testCase.time?.trim();
  if (time) {
    context.push(`Time context:\n${time}`);
  }
  const profile = testCase.profile?.trim();
  if (profile) {
    context.push(`Character profile:\n${profile}`);
  }
  return [COMMON_INSTRUCTION, ...context].join("\n\n");
}

function collectParserErrors(errors: string[]) {
  return {
    toolCallMiddleware: {
      onError: (message: string, metadata?: Record<string, unknown>) => {
        errors.push(
          `${message}${metadata ? ` ${JSON.stringify(metadata).slice(0, 500)}` : ""}`
        );
      },
    },
  };
}

function hasTextLeak(text: string, nameMap: NameMap[]): boolean {
  return (
    LEAK_PATTERNS.some((pattern) => text.includes(pattern)) ||
    nameMap.some(({ original, safe }) =>
      [`<${original}`, `</${original}`, `<${safe}`, `</${safe}`].some((tag) =>
        text.includes(tag)
      )
    )
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function runOne(
  testCase: AceCase,
  arm: Arm,
  options: ExecutionOptions
): Promise<RunResult> {
  const start = Date.now();
  const nameMap = safeFunctionNames(testCase.function);
  const reverseNames = new Map(
    nameMap.map(({ original, safe }) => [safe, original])
  );
  const rawCaptureIds: string[] = [];
  const tools = makeTools(testCase, nameMap);
  const captureTools = capturedTools(testCase, nameMap);
  for (let attempt = 1; ; attempt += 1) {
    const parserErrors: string[] = [];
    try {
      const result = await options.capture.run(
        {
          arm: arm.id,
          attempt,
          caseId: testCase.id,
          category: testCase.category,
          jobKey: `${testCase.language}\u0000${testCase.category}\u0000${testCase.id}\u0000${arm.id}`,
          language: testCase.language,
          suite: "ace",
          tools: captureTools,
          transport: options.benchmarkTransport,
          trial: 0,
        },
        rawCaptureIds,
        () =>
          runBenchmarkModel(
            {
              abortSignal: AbortSignal.timeout(options.requestTimeoutMs),
              instructions: makeInstructions(testCase),
              maxOutputTokens: 1024,
              maxRetries: 0,
              model: options.modelForArm(arm),
              prompt: testCase.question,
              providerOptions: arm.middleware
                ? (collectParserErrors(parserErrors) as never)
                : undefined,
              temperature: 0,
              toolChoice: "auto",
              tools,
            },
            options.benchmarkTransport
          )
      );
      return {
        arm: arm.id,
        attempts: attempt,
        calls: result.toolCalls.map((call) => ({
          arguments: call.input,
          name: reverseNames.get(call.toolName) ?? call.toolName,
        })),
        caseId: testCase.id,
        category: testCase.category,
        finishReason: result.finishReason,
        language: testCase.language,
        latencyMs: Date.now() - start,
        model: options.modelId,
        nameMap,
        parserErrors,
        rawCaptureIds,
        rawFinishReason: result.rawFinishReason,
        text: result.text.slice(0, 4000),
        textLeak: hasTextLeak(result.text, nameMap),
        transportOk: true,
        transport: options.benchmarkTransport,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
        },
      };
    } catch (error) {
      const normalizedError =
        error instanceof Error ? error : String(error).slice(0, 4000);
      const detail = credentialSafeError(normalizedError, [
        options.secretApiKey,
      ]);
      if (
        attempt <= options.retryLimit &&
        RETRYABLE_ERROR_PATTERN.test(detail)
      ) {
        await delay(1500 * attempt);
        continue;
      }
      return {
        arm: arm.id,
        attempts: attempt,
        calls: [],
        caseId: testCase.id,
        category: testCase.category,
        error: detail,
        language: testCase.language,
        latencyMs: Date.now() - start,
        model: options.modelId,
        nameMap,
        parserErrors,
        rawCaptureIds,
        text: "",
        textLeak: false,
        transportOk: false,
        transport: options.benchmarkTransport,
      };
    }
  }
}

export async function executeAceJobs(options: ExecutionOptions): Promise<void> {
  let cursor = 0;
  let finished = options.initialCompletedJobs;
  const startedAt = Date.now();
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          options.workerConcurrency,
          Math.max(1, options.batches.length)
        ),
      },
      async () => {
        while (cursor < options.batches.length) {
          const batch = options.batches[cursor];
          cursor += 1;
          for (const job of batch) {
            const result = await runOne(job.testCase, job.arm, options);
            appendFileSync(options.outputPath, `${JSON.stringify(result)}\n`);
            finished += 1;
            if (
              !result.transportOk ||
              result.parserErrors.length > 0 ||
              result.textLeak ||
              finished % 25 === 0
            ) {
              const rate =
                finished / Math.max((Date.now() - startedAt) / 1000, 0.001);
              console.log(
                `[${finished}/${options.totalJobs}] ${result.arm} ` +
                  `${result.language}/${result.category}/${result.caseId} ` +
                  `${result.transportOk ? "ok" : "ERROR"} ${result.latencyMs}ms ` +
                  `calls=${result.calls.length} rate=${rate.toFixed(2)}/s` +
                  (result.error ? ` ${result.error.slice(0, 180)}` : "")
              );
            }
          }
        }
      }
    )
  );
}
