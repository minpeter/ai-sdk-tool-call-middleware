import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4Middleware } from "@ai-sdk/provider";
import {
  jsonSchema,
  type ModelMessage,
  type ToolSet,
  wrapLanguageModel,
} from "ai";
import {
  sijawaraConciseXmlToolMiddleware,
  sijawaraDetailedXmlToolMiddleware,
  uiTarsToolMiddleware,
} from "../../../src/community/index";
import {
  glm5ToolMiddleware,
  hermesToolMiddleware,
  morphXmlToolMiddleware,
  qwen3CoderToolMiddleware,
  yamlXmlToolMiddleware,
} from "../../../src/preconfigured-middleware";
import { benchmarkTransport, runBenchmarkModel } from "./benchmark-model-call";
import {
  assertPairedResumeSymmetry,
  hasNativeGlm5Pair,
  pairedArmBatches,
} from "./paired-scheduling";
import {
  type CapturedFunctionTool,
  captureArmsFromEnv,
  credentialFreeUrl,
  credentialSafeError,
  ProviderCapture,
} from "./provider-capture";
import {
  assertGitRevision,
  assertResumeFingerprint,
  benchmarkImplementationFingerprint,
  configurationFingerprint,
} from "./run-resume-integrity";

const MODEL = process.env.BENCH_MODEL ?? "zai-org/glm-5.2";
const BASE_URL =
  process.env.FREEROUTER_BASE_URL ??
  "https://freerouter.minpeter.workers.dev/v1";
const DRY_RUN = process.env.BENCH_DRY_RUN === "1";
const API_KEY = DRY_RUN
  ? (process.env.FREEROUTER_API_KEY ?? "dry-run-not-used")
  : requireEnv("FREEROUTER_API_KEY");
const BFCL_ROOT = resolve(
  process.env.BFCL_ROOT ??
    "/tmp/bfcl-research/berkeley-function-call-leaderboard"
);
const BFCL_COMMIT =
  process.env.BFCL_COMMIT ?? "6ea57973c7a6097fd7c5915698c54c17c5b1b6c8";
const OUT = resolve(
  process.env.BENCH_OUT ??
    "benchmarks/glm-5.2-tool-calling/results/latest/raw.jsonl"
);
const META_OUT = join(dirname(OUT), "run-meta.json");
const CONCURRENCY = positiveInt("BENCH_CONCURRENCY", 16);
const LIMIT_PER_CATEGORY = nonNegativeInt("BENCH_LIMIT_PER_CATEGORY", 40);
const TRIALS = positiveInt("BENCH_TRIALS", 1);
const TIMEOUT_MS = positiveInt("BENCH_TIMEOUT_MS", 120_000);
const PROVIDER_RETRIES = nonNegativeInt("BENCH_PROVIDER_RETRIES", 2);
const RESUME = process.env.BENCH_RESUME === "1";
const RETRY_FAILED = process.env.BENCH_RETRY_FAILED === "1";
const SEED = nonNegativeInt("BENCH_SEED", 52);
const PRESEED_FROM = process.env.BENCH_PRESEED_FROM
  ? resolve(process.env.BENCH_PRESEED_FROM)
  : undefined;
const TRANSPORT = benchmarkTransport(process.env.BENCH_TRANSPORT);
const RAW_CAPTURE = new ProviderCapture({
  arms: captureArmsFromEnv(process.env.BENCH_RAW_CAPTURE_ARMS),
  enabled: process.env.BENCH_RAW_CAPTURE !== "0",
  output: resolve(
    process.env.BENCH_RAW_CAPTURE_OUT ??
      join(dirname(OUT), "provider-raw.jsonl")
  ),
  secretValues: [API_KEY],
});

const DEFAULT_CATEGORIES = [
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

type Category = (typeof DEFAULT_CATEGORIES)[number];
type ArmId =
  | "native"
  | "glm5"
  | "hermes"
  | "morphXml"
  | "yamlXml"
  | "qwen3Coder"
  | "sijawaraDetailed"
  | "sijawaraConcise"
  | "uiTars";

interface Arm {
  family: "glm5-prompt-only" | "native" | "hermes" | "morph" | "yaml" | "qwen";
  id: ArmId;
  middleware?: LanguageModelV4Middleware;
}

const ALL_ARMS: readonly Arm[] = [
  { id: "native", family: "native" },
  {
    id: "glm5",
    family: "glm5-prompt-only",
    middleware: glm5ToolMiddleware,
  },
  { id: "hermes", family: "hermes", middleware: hermesToolMiddleware },
  { id: "morphXml", family: "morph", middleware: morphXmlToolMiddleware },
  { id: "yamlXml", family: "yaml", middleware: yamlXmlToolMiddleware },
  {
    id: "qwen3Coder",
    family: "qwen",
    middleware: qwen3CoderToolMiddleware,
  },
  {
    id: "sijawaraDetailed",
    family: "morph",
    middleware: sijawaraDetailedXmlToolMiddleware,
  },
  {
    id: "sijawaraConcise",
    family: "morph",
    middleware: sijawaraConciseXmlToolMiddleware,
  },
  { id: "uiTars", family: "qwen", middleware: uiTarsToolMiddleware },
];

interface BfclFunction {
  description?: string;
  name: string;
  parameters: Record<string, unknown>;
}

interface BfclMessage {
  content: string;
  role: "assistant" | "system" | "user";
}

interface BfclCase {
  function: BfclFunction[];
  id: string;
  question: BfclMessage[][];
}

interface NameMap {
  original: string;
  safe: string;
}

interface NormalizedCall {
  arguments: unknown;
  name: string;
}

interface RunResult {
  arm: ArmId;
  attempts: number;
  calls: NormalizedCall[];
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

interface Job {
  arm: Arm;
  category: Category;
  testCase: BfclCase;
  trial: number;
}

const provider = createOpenAICompatible({
  name: "freerouter",
  apiKey: API_KEY,
  baseURL: BASE_URL,
  fetch: RAW_CAPTURE.fetch,
});

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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function requestedValues<T extends string>(
  envName: string,
  allowed: readonly T[]
): T[] {
  const requested = process.env[envName]
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!requested || requested.length === 0) {
    return [...allowed];
  }
  for (const value of requested) {
    if (!allowed.includes(value as T)) {
      throw new Error(`${envName} contains unsupported value: ${value}`);
    }
  }
  return requested as T[];
}

function loadJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function categoryPath(category: Category): string {
  return join(BFCL_ROOT, "bfcl_eval", "data", `BFCL_v4_${category}.json`);
}

function sampleRank(category: Category, caseId: string): string {
  return createHash("sha256")
    .update(`${SEED}\0${category}\0${caseId}`)
    .digest("hex");
}

function sampledCases(category: Category): BfclCase[] {
  const rows = loadJsonl<BfclCase>(categoryPath(category));
  if (LIMIT_PER_CATEGORY === 0 || rows.length <= LIMIT_PER_CATEGORY) {
    return rows;
  }
  return [...rows]
    .sort((left, right) => {
      const delta = sampleRank(category, left.id).localeCompare(
        sampleRank(category, right.id)
      );
      return delta === 0 ? left.id.localeCompare(right.id) : delta;
    })
    .slice(0, LIMIT_PER_CATEGORY)
    .sort((left, right) => left.id.localeCompare(right.id));
}

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

function makeModel(arm: Arm) {
  const model = provider(MODEL);
  return arm.middleware
    ? wrapLanguageModel({ model, middleware: arm.middleware })
    : model;
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

function normalizeError(error: unknown): string {
  return credentialSafeError(error, [API_KEY]);
}

function retryable(error: string): boolean {
  return RETRYABLE_ERROR_PATTERN.test(error);
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
  testCase: BfclCase,
  category: Category,
  arm: Arm,
  trial: number
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
      const result = await RAW_CAPTURE.run(
        {
          arm: arm.id,
          attempt,
          caseId: testCase.id,
          category,
          jobKey: `${category}\u0000${testCase.id}\u0000${arm.id}\u0000${trial}`,
          suite: "bfcl",
          tools: captureTools,
          transport: TRANSPORT,
          trial,
        },
        rawCaptureIds,
        () =>
          runBenchmarkModel(
            {
              abortSignal: AbortSignal.timeout(TIMEOUT_MS),
              instructions: makeInstructions(testCase),
              maxOutputTokens: 1024,
              maxRetries: 0,
              messages: makeMessages(testCase),
              model: makeModel(arm),
              providerOptions: arm.middleware
                ? (collectParserErrors(parserErrors) as never)
                : undefined,
              temperature: 0,
              toolChoice: "auto",
              tools,
            },
            TRANSPORT
          )
      );
      return {
        arm: arm.id,
        attempts: attempt,
        calls: result.toolCalls.map((call) => ({
          arguments: call.input,
          name: reverseNames.get(call.toolName) ?? call.toolName,
        })),
        category,
        caseId: testCase.id,
        finishReason: result.finishReason,
        latencyMs: Date.now() - start,
        model: MODEL,
        nameMap,
        parserErrors,
        rawCaptureIds,
        rawFinishReason: result.rawFinishReason,
        text: result.text.slice(0, 4000),
        textLeak: hasTextLeak(result.text, nameMap),
        transportOk: true,
        transport: TRANSPORT,
        trial,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
        },
      };
    } catch (error) {
      const detail = normalizeError(error);
      if (attempt <= PROVIDER_RETRIES && retryable(detail)) {
        await delay(1500 * attempt);
        continue;
      }
      return {
        arm: arm.id,
        attempts: attempt,
        calls: [],
        category,
        caseId: testCase.id,
        error: detail,
        latencyMs: Date.now() - start,
        model: MODEL,
        nameMap,
        parserErrors,
        rawCaptureIds,
        text: "",
        textLeak: false,
        transportOk: false,
        transport: TRANSPORT,
        trial,
      };
    }
  }
}

function jobKey(
  result: Pick<RunResult, "arm" | "caseId" | "category" | "trial">
) {
  return `${result.category}\u0000${result.caseId}\u0000${result.arm}\u0000${result.trial}`;
}

function reusableRows(
  source: string,
  selectedCases: ReadonlySet<string>,
  selectedArms: ReadonlySet<ArmId>
): RunResult[] {
  const reusable = new Map<string, RunResult>();
  for (const row of loadJsonl<RunResult>(source)) {
    if (
      !row.transportOk ||
      (row.transport ?? "generate") !== TRANSPORT ||
      row.trial > TRIALS ||
      !selectedArms.has(row.arm) ||
      !selectedCases.has(`${row.category}\u0000${row.caseId}`)
    ) {
      continue;
    }
    const key = jobKey(row);
    if (!reusable.has(key)) {
      reusable.set(key, row);
    }
  }
  return [...reusable.values()];
}

function initialRows(
  casesByCategory: ReadonlyMap<Category, BfclCase[]>,
  arms: readonly Arm[]
): RunResult[] {
  if (RESUME && PRESEED_FROM) {
    throw new Error(
      "BENCH_RESUME and BENCH_PRESEED_FROM are mutually exclusive"
    );
  }
  if (RESUME && existsSync(OUT)) {
    return loadJsonl<RunResult>(OUT);
  }
  if (!PRESEED_FROM) {
    return [];
  }
  const selectedCases = new Set(
    [...casesByCategory].flatMap(([category, rows]) =>
      rows.map((row) => `${category}\u0000${row.id}`)
    )
  );
  const preseedableArms = hasNativeGlm5Pair(arms)
    ? arms.filter((arm) => arm.id !== "native" && arm.id !== "glm5")
    : arms;
  return reusableRows(
    PRESEED_FROM,
    selectedCases,
    new Set(preseedableArms.map((arm) => arm.id))
  );
}

function buildJobBatches(
  casesByCategory: ReadonlyMap<Category, BfclCase[]>,
  arms: readonly Arm[],
  completed: ReadonlySet<string>
): Job[][] {
  const batches: Job[][] = [];
  for (const [category, testCases] of casesByCategory) {
    for (const testCase of testCases) {
      for (let trial = 1; trial <= TRIALS; trial += 1) {
        const armBatches = pairedArmBatches(
          arms,
          SEED,
          `${category}\u0000${testCase.id}\u0000${trial}`
        );
        for (const armBatch of armBatches) {
          const pending = armBatch.flatMap((arm) => {
            const job = { category, testCase, arm, trial };
            const key = jobKey({ ...job, arm: arm.id, caseId: testCase.id });
            return completed.has(key) ? [] : [job];
          });
          if (pending.length > 0) {
            batches.push(pending);
          }
        }
      }
    }
  }
  return batches;
}

async function main(): Promise<void> {
  assertGitRevision({
    expected: BFCL_COMMIT,
    label: "BFCL",
    root: BFCL_ROOT,
  });
  const categories = requestedValues<Category>(
    "BENCH_CATEGORIES",
    DEFAULT_CATEGORIES
  );
  const requestedArmIds = requestedValues<ArmId>(
    "BENCH_ARMS",
    ALL_ARMS.map((arm) => arm.id)
  );
  const arms = ALL_ARMS.filter((arm) => requestedArmIds.includes(arm.id));
  const casesByCategory = new Map(
    categories.map((category) => [category, sampledCases(category)] as const)
  );
  const categoryManifest = Object.fromEntries(
    [...casesByCategory].map(([category, rows]) => [
      category,
      { count: rows.length, ids: rows.map((row) => row.id) },
    ])
  );
  const pairedScheduling = {
    active: hasNativeGlm5Pair(arms),
    arms: ["native", "glm5"],
    method:
      "sequential-worker-batch-per-case-trial-with-hash-alternated-first-arm",
    seed: SEED,
  };
  const runConfig = {
    arms: arms.map(({ family, id }) => ({ family, id })),
    baseUrl: credentialFreeUrl(BASE_URL),
    bfclCommit: BFCL_COMMIT,
    bfclRoot: BFCL_ROOT,
    categories: categoryManifest,
    concurrency: CONCURRENCY,
    dryRun: DRY_RUN,
    implementationFingerprint: benchmarkImplementationFingerprint(),
    limitPerCategory: LIMIT_PER_CATEGORY,
    model: MODEL,
    pairedScheduling,
    providerRetries: PROVIDER_RETRIES,
    rawProviderCapture: RAW_CAPTURE.metadata(),
    seed: SEED,
    timeoutMs: TIMEOUT_MS,
    transport: TRANSPORT,
    trials: TRIALS,
  };
  const configFingerprint = configurationFingerprint(runConfig);
  assertResumeFingerprint({
    expected: configFingerprint,
    metaPath: META_OUT,
    outputPath: OUT,
    resume: RESUME,
  });
  const existing = initialRows(casesByCategory, arms);
  if (
    RESUME &&
    existing.some((row) => (row.transport ?? "generate") !== TRANSPORT)
  ) {
    throw new Error(
      `Cannot resume ${OUT}: existing rows use a different BENCH_TRANSPORT`
    );
  }
  const completed = new Set(
    existing.filter((result) => !RETRY_FAILED || result.transportOk).map(jobKey)
  );
  if (RESUME && hasNativeGlm5Pair(arms)) {
    assertPairedResumeSymmetry({
      completed,
      pairs: [...casesByCategory].flatMap(([category, rows]) =>
        rows.flatMap((row) =>
          Array.from({ length: TRIALS }, (_, index) => {
            const trial = index + 1;
            return {
              glm5Key: jobKey({
                arm: "glm5",
                caseId: row.id,
                category,
                trial,
              }),
              identity: `${category}/${row.id}/trial-${trial}`,
              nativeKey: jobKey({
                arm: "native",
                caseId: row.id,
                category,
                trial,
              }),
            };
          })
        )
      ),
    });
  }
  if (RAW_CAPTURE.metadata().enabled && RAW_CAPTURE.output === OUT) {
    throw new Error("BENCH_RAW_CAPTURE_OUT must differ from BENCH_OUT");
  }
  mkdirSync(dirname(OUT), { recursive: true });
  RAW_CAPTURE.prepare(RESUME, existing.length > 0);
  if (!RESUME) {
    writeFileSync(
      OUT,
      existing.map((row) => JSON.stringify(row)).join("\n") +
        (existing.length > 0 ? "\n" : "")
    );
  }

  const jobBatches = buildJobBatches(casesByCategory, arms, completed);
  const pendingJobs = jobBatches.reduce((sum, batch) => sum + batch.length, 0);

  const meta = {
    ...runConfig,
    configFingerprint,
    expectedCases: [...casesByCategory.values()].reduce(
      (sum, rows) => sum + rows.length,
      0
    ),
    expectedJobs:
      [...casesByCategory.values()].reduce(
        (sum, rows) => sum + rows.length,
        0
      ) *
      arms.length *
      TRIALS,
    preseedFrom: PRESEED_FROM,
    preseedRows: PRESEED_FROM ? existing.length : 0,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(META_OUT, `${JSON.stringify(meta, null, 2)}\n`);

  if (DRY_RUN) {
    console.log(
      `Dry run: ${meta.expectedCases} BFCL cases, ${meta.expectedJobs} jobs, no provider calls`
    );
    return;
  }

  console.log(
    `Running ${pendingJobs} jobs in ${jobBatches.length} worker batches ` +
      `(${categories.length} categories x ${arms.length} arms, concurrency=${CONCURRENCY})`
  );
  let cursor = 0;
  let finished = existing.length;
  const startedAt = Date.now();
  await Promise.all(
    Array.from(
      { length: Math.min(CONCURRENCY, Math.max(1, jobBatches.length)) },
      async () => {
        while (cursor < jobBatches.length) {
          const index = cursor;
          cursor += 1;
          for (const job of jobBatches[index]) {
            const result = await runOne(
              job.testCase,
              job.category,
              job.arm,
              job.trial
            );
            appendFileSync(OUT, `${JSON.stringify(result)}\n`);
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
                `[${finished}/${pendingJobs + existing.length}] ${result.arm} ${result.category}/${result.caseId} ` +
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
  await RAW_CAPTURE.flush();
  console.log(`Completed ${pendingJobs} new jobs; raw results: ${OUT}`);
}

main().catch(async (error) => {
  await RAW_CAPTURE.flush();
  console.error(error);
  process.exitCode = 1;
});
