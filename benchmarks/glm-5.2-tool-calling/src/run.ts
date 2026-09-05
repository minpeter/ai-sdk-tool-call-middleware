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
  type Arm,
  type ArmId,
  type BfclCase,
  type Category,
  DEFAULT_CATEGORIES,
  executeBfclJobs,
  type Job,
  type RunResult,
} from "./run-bfcl-execution";
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

const provider = createOpenAICompatible({
  name: "freerouter",
  apiKey: API_KEY,
  baseURL: BASE_URL,
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

function makeModel(arm: Arm) {
  const model = provider(MODEL);
  return arm.middleware
    ? wrapLanguageModel({ model, middleware: arm.middleware })
    : model;
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
  await executeBfclJobs({
    apiKey: API_KEY,
    concurrency: CONCURRENCY,
    existingRows: existing.length,
    jobBatches,
    makeModel,
    model: MODEL,
    output: OUT,
    providerRetries: PROVIDER_RETRIES,
    rawCapture: RAW_CAPTURE,
    timeoutMs: TIMEOUT_MS,
    transport: TRANSPORT,
  });
  await RAW_CAPTURE.flush();
  console.log(`Completed ${pendingJobs} new jobs; raw results: ${OUT}`);
}

main().catch(async (error) => {
  await RAW_CAPTURE.flush();
  console.error(error);
  process.exitCode = 1;
});
