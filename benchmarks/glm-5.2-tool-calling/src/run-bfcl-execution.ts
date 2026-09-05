import { appendFileSync } from "node:fs";
import type { LanguageModelV4Middleware } from "@ai-sdk/provider";
import { jsonSchema, type ModelMessage, type ToolSet } from "ai";
import { runBenchmarkModel } from "./benchmark-model-call";
import {
  type CapturedFunctionTool,
  credentialSafeText,
  type ProviderCapture,
} from "./provider-capture";

export const DEFAULT_CATEGORIES = [
  "simple_python",
  "multiple",
  "parallel",
  "parallel_multiple",
  "simple_java",
  "simple_javascript",
  "irrelevance",
  "live_simple",
  "live_multiple",
  "live_parallel",
  "live_parallel_multiple",
  "live_irrelevance",
  "live_relevance",
] as const;

export type Category = (typeof DEFAULT_CATEGORIES)[number];
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
  family: "glm5-prompt-only" | "native" | "hermes" | "morph" | "yaml" | "qwen";
  id: ArmId;
  middleware?: LanguageModelV4Middleware;
}

interface BfclFunction {
  description?: string;
  name: string;
  parameters: Record<string, unknown>;
}

interface BfclMessage {
  content: string;
  role: "assistant" | "system" | "user";
}

export interface BfclCase {
  function: BfclFunction[];
  id: string;
  question: BfclMessage[][];
}

interface NameMap {
  original: string;
  safe: string;
}

export interface RunResult {
  arm: ArmId;
  attempts: number;
  calls: Array<{ arguments: unknown; name: string }>;
  caseId: string;
  category: Category;
  error?: string;
  finishReason?: string;
  latencyMs: number;
  model: string;
  nameMap: NameMap[];
  parserErrors: string[];
  rawCaptureIds: string[];
  rawFinishReason?: string;
  text: string;
  textLeak: boolean;
  transport: "generate" | "stream";
  transportOk: boolean;
  trial: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

export interface Job {
  arm: Arm;
  category: Category;
  testCase: BfclCase;
  trial: number;
}

interface ExecutionOptions {
  readonly apiKey: string;
  readonly concurrency: number;
  readonly existingRows: number;
  readonly jobBatches: readonly (readonly Job[])[];
  readonly makeModel: (
    arm: Arm
  ) => Parameters<typeof runBenchmarkModel>[0]["model"];
  readonly model: string;
  readonly output: string;
  readonly providerRetries: number;
  readonly rawCapture: ProviderCapture;
  readonly timeoutMs: number;
  readonly transport: "generate" | "stream";
}

const SYSTEM_PROMPT =
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

function safeFunctionNames(functions: BfclFunction[]): NameMap[] {
  const used = new Set<string>();
  return functions.map(({ name }, index) => {
    const stem =
      name
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
    return { original: name, safe };
  });
}

function normalizeType(type: unknown): unknown {
  if (Array.isArray(type)) {
    return type.map(normalizeType);
  }
  const mapping: Record<string, string | undefined> = {
    any: "string",
    Any: "string",
    Array: "array",
    ArrayList: "array",
    array: "array",
    Bigint: "integer",
    boolean: "boolean",
    Boolean: "boolean",
    bool: "boolean",
    byte: "integer",
    char: "string",
    dict: "object",
    double: "number",
    float: "number",
    HashMap: "object",
    Hashtable: "object",
    integer: "integer",
    list: "array",
    long: "integer",
    number: "number",
    object: "object",
    Queue: "array",
    Set: "array",
    short: "integer",
    Stack: "array",
    String: "string",
    string: "string",
    tuple: "array",
  };
  return typeof type === "string" && type in mapping ? mapping[type] : type;
}

function toJsonSchema(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const schema = value as Record<string, unknown>;
  const result: Record<string, unknown> = { ...schema };
  result.optional = undefined;
  if (schema.type !== undefined) {
    result.type = normalizeType(schema.type);
  }
  if (
    schema.properties !== null &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
  ) {
    result.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, child]) => [
        name,
        toJsonSchema(child),
      ])
    );
  }
  if (Array.isArray(schema.items)) {
    result.items = schema.items.map(toJsonSchema);
  } else if (schema.items && typeof schema.items === "object") {
    result.items = toJsonSchema(schema.items);
  }
  if (
    schema.additionalProperties &&
    typeof schema.additionalProperties === "object"
  ) {
    result.additionalProperties = toJsonSchema(schema.additionalProperties);
  }
  for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    const alternatives = schema[keyword];
    if (Array.isArray(alternatives)) {
      result[keyword] = alternatives.map(toJsonSchema);
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

function makeTools(testCase: BfclCase, nameMap: NameMap[]): ToolSet {
  const tools: ToolSet = {};
  for (const [index, definition] of testCase.function.entries()) {
    const mapped = nameMap[index];
    tools[mapped.safe] = {
      description: definition.description,
      inputSchema: jsonSchema(
        toJsonSchema(definition.parameters) as Record<string, unknown>
      ),
    };
  }
  return tools;
}

function capturedTools(
  testCase: BfclCase,
  nameMap: NameMap[]
): CapturedFunctionTool[] {
  return testCase.function.map((definition, index) => ({
    description: definition.description,
    inputSchema: toJsonSchema(definition.parameters),
    name: nameMap[index].safe,
    originalName: nameMap[index].original,
  }));
}

function makeMessages(testCase: BfclCase): ModelMessage[] {
  const firstTurn = testCase.question[0] ?? [];
  return firstTurn
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role,
      content: message.content,
    })) as ModelMessage[];
}

function makeInstructions(testCase: BfclCase): string {
  const caseInstructions = (testCase.question[0] ?? [])
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean);
  return [SYSTEM_PROMPT, ...caseInstructions].join("\n\n");
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

async function runOne(job: Job, options: ExecutionOptions): Promise<RunResult> {
  const start = Date.now();
  const nameMap = safeFunctionNames(job.testCase.function);
  const reverseNames = new Map(
    nameMap.map(({ original, safe }) => [safe, original])
  );
  const rawCaptureIds: string[] = [];
  const tools = makeTools(job.testCase, nameMap);
  const captureTools = capturedTools(job.testCase, nameMap);
  const model = options.makeModel(job.arm);

  for (let attempt = 1; ; attempt += 1) {
    const parserErrors: string[] = [];
    try {
      const result = await options.rawCapture.run(
        {
          arm: job.arm.id,
          attempt,
          caseId: job.testCase.id,
          category: job.category,
          jobKey: `${job.category}\u0000${job.testCase.id}\u0000${job.arm.id}\u0000${job.trial}`,
          suite: "bfcl",
          tools: captureTools,
          transport: options.transport,
          trial: job.trial,
        },
        rawCaptureIds,
        () =>
          runBenchmarkModel(
            {
              abortSignal: AbortSignal.timeout(options.timeoutMs),
              instructions: makeInstructions(job.testCase),
              maxOutputTokens: 1024,
              maxRetries: 0,
              messages: makeMessages(job.testCase),
              model,
              providerOptions: job.arm.middleware
                ? (collectParserErrors(parserErrors) as never)
                : undefined,
              temperature: 0,
              toolChoice: "auto",
              tools,
            },
            options.transport
          )
      );
      return {
        arm: job.arm.id,
        attempts: attempt,
        calls: result.toolCalls.map((call) => ({
          arguments: call.input,
          name: reverseNames.get(call.toolName) ?? call.toolName,
        })),
        category: job.category,
        caseId: job.testCase.id,
        finishReason: result.finishReason,
        latencyMs: Date.now() - start,
        model: options.model,
        nameMap,
        parserErrors,
        rawCaptureIds,
        rawFinishReason: result.rawFinishReason,
        text: result.text.slice(0, 4000),
        textLeak: hasTextLeak(result.text, nameMap),
        transportOk: true,
        transport: options.transport,
        trial: job.trial,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
        },
      };
    } catch (error) {
      const detail = credentialSafeText(
        (error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error)
        ).slice(0, 4000),
        [options.apiKey]
      );
      if (
        attempt <= options.providerRetries &&
        RETRYABLE_ERROR_PATTERN.test(detail)
      ) {
        await delay(1500 * attempt);
        continue;
      }
      return {
        arm: job.arm.id,
        attempts: attempt,
        calls: [],
        category: job.category,
        caseId: job.testCase.id,
        error: detail,
        latencyMs: Date.now() - start,
        model: options.model,
        nameMap,
        parserErrors,
        rawCaptureIds,
        text: "",
        textLeak: false,
        transportOk: false,
        transport: options.transport,
        trial: job.trial,
      };
    }
  }
}

export async function executeBfclJobs(
  options: ExecutionOptions
): Promise<void> {
  const pendingJobs = options.jobBatches.reduce(
    (sum, batch) => sum + batch.length,
    0
  );
  let cursor = 0;
  let finished = options.existingRows;
  const startedAt = Date.now();
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          options.concurrency,
          Math.max(1, options.jobBatches.length)
        ),
      },
      async () => {
        while (cursor < options.jobBatches.length) {
          const index = cursor;
          cursor += 1;
          for (const job of options.jobBatches[index]) {
            const result = await runOne(job, options);
            appendFileSync(options.output, `${JSON.stringify(result)}\n`);
            finished += 1;
            if (
              !result.transportOk ||
              result.parserErrors.length > 0 ||
              result.textLeak ||
              finished % 25 === 0
            ) {
              const elapsedSeconds = (Date.now() - startedAt) / 1000;
              const rate = finished / Math.max(elapsedSeconds, 0.001);
              console.log(
                `[${finished}/${pendingJobs + options.existingRows}] ${result.arm} ${result.category}/${result.caseId} ` +
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
