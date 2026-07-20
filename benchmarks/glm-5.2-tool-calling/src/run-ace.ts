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
import { jsonSchema, type ToolSet, wrapLanguageModel } from "ai";
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
const ACE_ROOT = resolve(
  process.env.ACE_ROOT ?? "/tmp/acebench-function-calling"
);
const OUT = resolve(
  process.env.BENCH_OUT ??
    "benchmarks/glm-5.2-tool-calling/results/ace-latest/raw.jsonl"
);
const META_OUT = join(dirname(OUT), "run-meta.json");
const CONCURRENCY = positiveInt("BENCH_CONCURRENCY", 16);
const TIMEOUT_MS = positiveInt("BENCH_TIMEOUT_MS", 120_000);
const PROVIDER_RETRIES = nonNegativeInt("BENCH_PROVIDER_RETRIES", 2);
const RESUME = process.env.BENCH_RESUME === "1";
const RETRY_FAILED = process.env.BENCH_RETRY_FAILED === "1";
const SEED = nonNegativeInt("BENCH_SEED", 52);
const ACE_COMMIT = "56dd66cf6439b0d9655ee1b353e4cd745c6f664e";
const CASES_PER_STRATUM = positiveInt("ACE_CASES_PER_STRATUM", 5);
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

const LANGUAGES = ["en", "zh"] as const;
const CATEGORIES = [
  "normal_single_turn_single_function",
  "normal_single_turn_parallel_function",
  "normal_similar_api",
  "normal_preference",
  "normal_atom_bool",
  "normal_atom_enum",
  "normal_atom_number",
  "normal_atom_list",
  "normal_atom_object_deep",
  "normal_atom_object_short",
] as const;

type Language = (typeof LANGUAGES)[number];
type Category = (typeof CATEGORIES)[number];
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
  id: ArmId;
  middleware?: LanguageModelV4Middleware;
}

const ALL_ARMS: readonly Arm[] = [
  { id: "native" },
  { id: "glm5", middleware: glm5ToolMiddleware },
  { id: "hermes", middleware: hermesToolMiddleware },
  { id: "morphXml", middleware: morphXmlToolMiddleware },
  { id: "yamlXml", middleware: yamlXmlToolMiddleware },
  { id: "qwen3Coder", middleware: qwen3CoderToolMiddleware },
  { id: "sijawaraDetailed", middleware: sijawaraDetailedXmlToolMiddleware },
  { id: "sijawaraConcise", middleware: sijawaraConciseXmlToolMiddleware },
  { id: "uiTars", middleware: uiTarsToolMiddleware },
];

interface OracleInvalidCase {
  category: Category;
  id: string;
  language: Language;
  sourceLine: number;
}

// These rows have invalid official oracle answers in the pinned ACEBench commit.
// sourceLine is one-based; each dataset ID uses the zero-based line suffix.
const ORACLE_INVALID_CASES = [
  {
    category: "normal_single_turn_parallel_function",
    id: "normal_single_turn_parallel_function_42",
    language: "en",
    sourceLine: 43,
  },
  {
    category: "normal_preference",
    id: "normal_preference_40",
    language: "en",
    sourceLine: 41,
  },
  {
    category: "normal_single_turn_parallel_function",
    id: "normal_single_turn_parallel_function_45",
    language: "zh",
    sourceLine: 46,
  },
  {
    category: "normal_single_turn_parallel_function",
    id: "normal_single_turn_parallel_function_80",
    language: "zh",
    sourceLine: 81,
  },
  {
    category: "normal_similar_api",
    id: "normal_similar_api_2",
    language: "zh",
    sourceLine: 3,
  },
  {
    category: "normal_similar_api",
    id: "normal_similar_api_22",
    language: "zh",
    sourceLine: 23,
  },
  {
    category: "normal_atom_list",
    id: "normal_atom_list_28",
    language: "zh",
    sourceLine: 29,
  },
  {
    category: "normal_atom_object_short",
    id: "normal_atom_object_short_1",
    language: "zh",
    sourceLine: 2,
  },
] as const satisfies readonly OracleInvalidCase[];

interface AceFunction {
  _arguments?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
  description?: string;
  name: string;
  parameters?: Record<string, unknown>;
}

interface AceCase {
  category: Category;
  function: AceFunction[];
  id: string;
  language: Language;
  profile?: string;
  question: string;
  time?: string;
}

interface NameMap {
  original: string;
  safe: string;
}

interface RunResult {
  arm: ArmId;
  attempts: number;
  calls: Array<{ arguments: unknown; name: string }>;
  caseId: string;
  category: Category;
  error?: string;
  finishReason?: string;
  language: Language;
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
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

interface Job {
  arm: Arm;
  testCase: AceCase;
}

const provider = createOpenAICompatible({
  apiKey: API_KEY,
  baseURL: BASE_URL,
  name: "freerouter",
  fetch: RAW_CAPTURE.fetch,
});

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

function caseKey(language: Language, category: Category, id: string): string {
  return `${language}\u0000${category}\u0000${id}`;
}

function sampleRank(language: Language, category: Category, id: string) {
  return createHash("sha256")
    .update(
      `${SEED}\u0000${ACE_COMMIT}\u0000${language}\u0000${category}\u0000${id}`
    )
    .digest("hex");
}

function loadCases(language: Language, category: Category): AceCase[] {
  const path = join(
    ACE_ROOT,
    "data_all",
    `data_${language}`,
    `data_${category}.json`
  );
  const rows = loadJsonl<Omit<AceCase, "category" | "language">>(path);
  const invalidRows = ORACLE_INVALID_CASES.filter(
    (row) => row.language === language && row.category === category
  );
  for (const invalid of invalidRows) {
    const rowAtPinnedLine = rows[invalid.sourceLine - 1];
    if (rowAtPinnedLine?.id !== invalid.id) {
      throw new Error(
        `ACE oracle exclusion mismatch at ${language}/${category}:${invalid.sourceLine}; ` +
          `expected ${invalid.id}, found ${rowAtPinnedLine?.id ?? "no row"}`
      );
    }
  }
  const invalidIds = new Set<string>(invalidRows.map((row) => row.id));
  const eligible = rows.filter((row) => !invalidIds.has(row.id));
  if (eligible.length < CASES_PER_STRATUM) {
    throw new Error(
      `ACE stratum ${language}/${category} has only ${eligible.length} eligible cases`
    );
  }
  return eligible
    .sort((left, right) => {
      const delta = sampleRank(language, category, left.id).localeCompare(
        sampleRank(language, category, right.id)
      );
      return delta === 0 ? left.id.localeCompare(right.id) : delta;
    })
    .slice(0, CASES_PER_STRATUM)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((row) => ({ ...row, category, language }));
}

function safeFunctionNames(functions: AceFunction[]): NameMap[] {
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

function makeModel(arm: Arm) {
  const model = provider(MODEL);
  return arm.middleware
    ? wrapLanguageModel({ middleware: arm.middleware, model })
    : model;
}

function makeInstructions(testCase: AceCase): string {
  const context = [
    testCase.time?.trim() ? `Time context:\n${testCase.time.trim()}` : "",
    testCase.profile?.trim()
      ? `Character profile:\n${testCase.profile.trim()}`
      : "",
  ].filter(Boolean);
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

async function runOne(testCase: AceCase, arm: Arm): Promise<RunResult> {
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
          category: testCase.category,
          jobKey: `${testCase.language}\u0000${testCase.category}\u0000${testCase.id}\u0000${arm.id}`,
          language: testCase.language,
          suite: "ace",
          tools: captureTools,
          transport: TRANSPORT,
          trial: 0,
        },
        rawCaptureIds,
        () =>
          runBenchmarkModel(
            {
              abortSignal: AbortSignal.timeout(TIMEOUT_MS),
              instructions: makeInstructions(testCase),
              maxOutputTokens: 1024,
              maxRetries: 0,
              model: makeModel(arm),
              prompt: testCase.question,
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
        caseId: testCase.id,
        category: testCase.category,
        finishReason: result.finishReason,
        language: testCase.language,
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
        caseId: testCase.id,
        category: testCase.category,
        error: detail,
        language: testCase.language,
        latencyMs: Date.now() - start,
        model: MODEL,
        nameMap,
        parserErrors,
        rawCaptureIds,
        text: "",
        textLeak: false,
        transportOk: false,
        transport: TRANSPORT,
      };
    }
  }
}

function jobKey(
  row: Pick<RunResult, "arm" | "caseId" | "category" | "language">
) {
  return `${row.language}\u0000${row.category}\u0000${row.caseId}\u0000${row.arm}`;
}

function buildJobBatches(
  cases: readonly AceCase[],
  arms: readonly Arm[],
  completed: ReadonlySet<string>
): Job[][] {
  const batches: Job[][] = [];
  for (const testCase of cases) {
    const armBatches = pairedArmBatches(
      arms,
      SEED,
      `${testCase.language}\u0000${testCase.category}\u0000${testCase.id}`
    );
    for (const armBatch of armBatches) {
      const pending = armBatch.flatMap((arm) => {
        const key = jobKey({
          arm: arm.id,
          caseId: testCase.id,
          category: testCase.category,
          language: testCase.language,
        });
        return completed.has(key) ? [] : [{ arm, testCase }];
      });
      if (pending.length > 0) {
        batches.push(pending);
      }
    }
  }
  return batches;
}

function validatePanel(cases: readonly AceCase[], arms: readonly Arm[]): void {
  const expectedCases =
    LANGUAGES.length * CATEGORIES.length * CASES_PER_STRATUM;
  if (ORACLE_INVALID_CASES.length !== 8) {
    throw new Error(
      `Expected exactly 8 ACE oracle exclusions, found ${ORACLE_INVALID_CASES.length}`
    );
  }
  const invalidKeys = new Set(
    ORACLE_INVALID_CASES.map((row) =>
      caseKey(row.language, row.category, row.id)
    )
  );
  if (invalidKeys.size !== ORACLE_INVALID_CASES.length) {
    throw new Error("ACE oracle exclusion list contains duplicate case keys");
  }
  if (
    arms.length === 0 ||
    new Set(arms.map((arm) => arm.id)).size !== arms.length
  ) {
    throw new Error("ACE protocol panel must contain unique arms");
  }
  if (cases.length !== expectedCases) {
    throw new Error(
      `Expected ${expectedCases} ACE cases, selected ${cases.length}`
    );
  }
  const selectedKeys = new Set(
    cases.map((row) => caseKey(row.language, row.category, row.id))
  );
  if (selectedKeys.size !== cases.length) {
    throw new Error("ACE panel contains duplicate language/category/case keys");
  }
  for (const invalidKey of invalidKeys) {
    if (selectedKeys.has(invalidKey)) {
      throw new Error(`Oracle-invalid ACE case reached sample: ${invalidKey}`);
    }
  }
}

async function main(): Promise<void> {
  assertGitRevision({
    expected: ACE_COMMIT,
    label: "ACEBench",
    root: ACE_ROOT,
  });
  const requestedArmIds = requestedValues<ArmId>(
    "BENCH_ARMS",
    ALL_ARMS.map((arm) => arm.id)
  );
  const arms = ALL_ARMS.filter((arm) => requestedArmIds.includes(arm.id));
  const cases = LANGUAGES.flatMap((language) =>
    CATEGORIES.flatMap((category) => loadCases(language, category))
  );
  validatePanel(cases, arms);
  const pairedScheduling = {
    active: hasNativeGlm5Pair(arms),
    arms: ["native", "glm5"],
    method: "sequential-worker-batch-per-case-with-hash-alternated-first-arm",
    seed: SEED,
  };
  const runConfig = {
    aceCommit: ACE_COMMIT,
    aceRoot: ACE_ROOT,
    arms: arms.map((arm) => arm.id),
    baseUrl: credentialFreeUrl(BASE_URL),
    cases: cases.map(({ category, id, language }) => ({
      category,
      id,
      language,
    })),
    casesPerStratum: CASES_PER_STRATUM,
    categories: CATEGORIES,
    concurrency: CONCURRENCY,
    dryRun: DRY_RUN,
    implementationFingerprint: benchmarkImplementationFingerprint(),
    languages: LANGUAGES,
    model: MODEL,
    oracleInvalidCases: ORACLE_INVALID_CASES,
    pairedScheduling,
    providerRetries: PROVIDER_RETRIES,
    rawProviderCapture: RAW_CAPTURE.metadata(),
    seed: SEED,
    timeoutMs: TIMEOUT_MS,
    transport: TRANSPORT,
  };
  const configFingerprint = configurationFingerprint(runConfig);
  assertResumeFingerprint({
    expected: configFingerprint,
    metaPath: META_OUT,
    outputPath: OUT,
    resume: RESUME,
  });
  const existing = RESUME && existsSync(OUT) ? loadJsonl<RunResult>(OUT) : [];
  if (
    RESUME &&
    existing.some((row) => (row.transport ?? "generate") !== TRANSPORT)
  ) {
    throw new Error(
      `Cannot resume ${OUT}: existing rows use a different BENCH_TRANSPORT`
    );
  }
  const expectedJobKeys = new Set(
    cases.flatMap((testCase) =>
      arms.map((arm) =>
        jobKey({
          arm: arm.id,
          caseId: testCase.id,
          category: testCase.category,
          language: testCase.language,
        })
      )
    )
  );
  const completed = new Set(
    existing
      .filter((row) => !RETRY_FAILED || row.transportOk)
      .map(jobKey)
      .filter((key) => expectedJobKeys.has(key))
  );
  if (RESUME && hasNativeGlm5Pair(arms)) {
    assertPairedResumeSymmetry({
      completed,
      pairs: cases.map((testCase) => ({
        glm5Key: jobKey({
          arm: "glm5",
          caseId: testCase.id,
          category: testCase.category,
          language: testCase.language,
        }),
        identity: `${testCase.language}/${testCase.category}/${testCase.id}`,
        nativeKey: jobKey({
          arm: "native",
          caseId: testCase.id,
          category: testCase.category,
          language: testCase.language,
        }),
      })),
    });
  }
  const jobBatches = buildJobBatches(cases, arms, completed);
  const pendingJobs = jobBatches.reduce((sum, batch) => sum + batch.length, 0);
  if (RAW_CAPTURE.metadata().enabled && RAW_CAPTURE.output === OUT) {
    throw new Error("BENCH_RAW_CAPTURE_OUT must differ from BENCH_OUT");
  }
  mkdirSync(dirname(OUT), { recursive: true });
  RAW_CAPTURE.prepare(RESUME, existing.length > 0);
  if (!RESUME) {
    writeFileSync(OUT, "");
  }
  writeFileSync(
    META_OUT,
    `${JSON.stringify(
      {
        ...runConfig,
        configFingerprint,
        expectedCases: LANGUAGES.length * CATEGORIES.length * CASES_PER_STRATUM,
        expectedJobs: expectedJobKeys.size,
        startedAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`
  );
  if (DRY_RUN) {
    console.log(
      `Dry run: ${runConfig.cases.length} ACE cases, ${expectedJobKeys.size} jobs, no provider calls`
    );
    return;
  }
  console.log(
    `Running ${pendingJobs} ACE jobs in ${jobBatches.length} worker batches from ${cases.length} cases ` +
      `(${completed.size}/${expectedJobKeys.size} already complete, concurrency=${CONCURRENCY})`
  );
  let cursor = 0;
  let finished = completed.size;
  const startedAt = Date.now();
  await Promise.all(
    Array.from(
      { length: Math.min(CONCURRENCY, Math.max(1, jobBatches.length)) },
      async () => {
        while (cursor < jobBatches.length) {
          const batch = jobBatches[cursor];
          cursor += 1;
          for (const job of batch) {
            const result = await runOne(job.testCase, job.arm);
            appendFileSync(OUT, `${JSON.stringify(result)}\n`);
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
                `[${finished}/${expectedJobKeys.size}] ${result.arm} ` +
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
  await RAW_CAPTURE.flush();
  console.log(`Completed ACE run -> ${OUT}`);
}

main().catch(async (error) => {
  await RAW_CAPTURE.flush();
  console.error(error);
  process.exitCode = 1;
});
