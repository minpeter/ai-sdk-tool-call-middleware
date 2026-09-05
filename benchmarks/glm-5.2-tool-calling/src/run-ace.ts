import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel } from "ai";
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
import { benchmarkTransport } from "./benchmark-model-call";
import {
  assertPairedResumeSymmetry,
  hasNativeGlm5Pair,
  pairedArmBatches,
} from "./paired-scheduling";
import {
  captureArmsFromEnv,
  credentialFreeUrl,
  ProviderCapture,
} from "./provider-capture";
import {
  type AceCase,
  type Arm,
  type ArmId,
  type Category,
  executeAceJobs,
  type Job,
  type Language,
  type RunResult,
} from "./run-ace-execution";
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

const provider = createOpenAICompatible({
  apiKey: API_KEY,
  baseURL: BASE_URL,
  name: "freerouter",
  fetch: RAW_CAPTURE.fetch,
});

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

function makeModel(arm: Arm) {
  const model = provider(MODEL);
  return arm.middleware
    ? wrapLanguageModel({ middleware: arm.middleware, model })
    : model;
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
  await executeAceJobs({
    batches: jobBatches,
    benchmarkTransport: TRANSPORT,
    capture: RAW_CAPTURE,
    initialCompletedJobs: completed.size,
    modelForArm: makeModel,
    modelId: MODEL,
    outputPath: OUT,
    requestTimeoutMs: TIMEOUT_MS,
    retryLimit: PROVIDER_RETRIES,
    secretApiKey: API_KEY,
    totalJobs: expectedJobKeys.size,
    workerConcurrency: CONCURRENCY,
  });
  await RAW_CAPTURE.flush();
  console.log(`Completed ACE run -> ${OUT}`);
}

main().catch(async (error) => {
  await RAW_CAPTURE.flush();
  console.error(error);
  process.exitCode = 1;
});
