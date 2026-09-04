import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
import { FILESYSTEM_MCP_PACKAGE } from "./mcp-stdio-client";
import {
  discoverOfficialEasyTasks,
  FILESYSTEM_CATEGORIES,
  MCPMARK_COMMIT,
  nonNegativeInt,
  OFFICIAL_EASY_TASK_IDS,
  positiveInt,
  preflightFilesystemServer,
  prepareFilesystemData,
  requireEnv,
  resultPathFromOut,
  sha256Text,
  stableJson,
} from "./mcpmark-filesystem-common";
import { hasNativeGlm5Pair } from "./paired-scheduling";
import { credentialFreeUrl } from "./provider-capture";
import { createMcpmarkExecutor } from "./run-mcpmark-execution";
import {
  type Arm,
  type ArmId,
  armIds,
  initializeResultOutput,
  prepareResume,
  requestedTasks,
  requestedValues,
  retentionMode,
  runAndReportBatches,
} from "./run-mcpmark-reporting";
import { benchmarkImplementationFingerprint } from "./run-resume-integrity";

const MODEL = process.env.BENCH_MODEL ?? "zai-org/glm-5.2";
const BASE_URL =
  process.env.FREEROUTER_BASE_URL ??
  "https://freerouter.minpeter.workers.dev/v1";
const DRY_RUN =
  (process.env.MCPMARK_DRY_RUN ?? process.env.BENCH_DRY_RUN) === "1";
const API_KEY = DRY_RUN
  ? (process.env.FREEROUTER_API_KEY ?? "dry-run-not-used")
  : requireEnv("FREEROUTER_API_KEY");
const MCPMARK_ROOT = resolve(
  process.env.MCPMARK_ROOT ?? "/tmp/mcpmark-research"
);
const DATA_ROOT = resolve(
  process.env.MCPMARK_DATA_ROOT ?? "/tmp/mcpmark-filesystem-data"
);
const SNAPSHOT_ROOT = resolve(
  process.env.MCPMARK_SNAPSHOT_ROOT ?? "/tmp/mcpmark-filesystem-runs"
);
const OUT = resolve(
  process.env.MCPMARK_OUT ??
    "benchmarks/glm-5.2-tool-calling/results/mcpmark-latest/raw.jsonl"
);
const META_OUT = resultPathFromOut(OUT, "run-meta.json");
const CONCURRENCY = positiveInt("MCPMARK_CONCURRENCY", 4);
const TRIALS = positiveInt("MCPMARK_TRIALS", 1);
const MAX_TURNS = positiveInt("MCPMARK_MAX_TURNS", 100);
const MAX_OUTPUT_TOKENS = positiveInt("MCPMARK_MAX_OUTPUT_TOKENS", 4096);
const PROVIDER_TIMEOUT_MS = positiveInt("MCPMARK_PROVIDER_TIMEOUT_MS", 120_000);
const MCP_TIMEOUT_MS = positiveInt("MCPMARK_MCP_TIMEOUT_MS", 60_000);
const VERIFIER_TIMEOUT_MS = positiveInt("MCPMARK_VERIFIER_TIMEOUT_MS", 120_000);
const ATTEMPT_TIMEOUT_MS = positiveInt("MCPMARK_ATTEMPT_TIMEOUT_MS", 600_000);
const RETRIES = nonNegativeInt(
  "MCPMARK_RETRIES",
  nonNegativeInt("MCPMARK_PROVIDER_RETRIES", 2)
);
const RESUME = process.env.MCPMARK_RESUME === "1";
const RETRY_FAILED = process.env.MCPMARK_RETRY_FAILED === "1";
const PAIR_SEED = nonNegativeInt("MCPMARK_PAIR_SEED", 52);
const TRANSPORT = benchmarkTransport(
  process.env.MCPMARK_TRANSPORT ?? process.env.BENCH_TRANSPORT
);
const KEEP_SNAPSHOTS = retentionMode(
  process.env.MCPMARK_KEEP_SNAPSHOTS ?? "failed"
);
const RAW_CAPTURE_OUT = resolve(
  process.env.MCPMARK_RAW_CAPTURE_OUT ??
    process.env.BENCH_RAW_CAPTURE_OUT ??
    join(dirname(OUT), "provider-raw.jsonl")
);
const RUNNER_REVISION = 5;
const SYSTEM_PROMPT =
  "You are a helpful agent that uses tools iteratively to complete the user's task, " +
  'and when finished, provides the final answer or simply states "Task completed" without further tool calls.';
const EXECUTOR = createMcpmarkExecutor({
  apiKey: API_KEY,
  attemptTimeoutMs: ATTEMPT_TIMEOUT_MS,
  baseUrl: BASE_URL,
  dataRoot: DATA_ROOT,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
  maxTurns: MAX_TURNS,
  mcpTimeoutMs: MCP_TIMEOUT_MS,
  model: MODEL,
  out: RAW_CAPTURE_OUT,
  providerTimeoutMs: PROVIDER_TIMEOUT_MS,
  retries: RETRIES,
  snapshotRetention: KEEP_SNAPSHOTS,
  snapshotRoot: SNAPSHOT_ROOT,
  systemPrompt: SYSTEM_PROMPT,
  transport: TRANSPORT,
  verifierTimeoutMs: VERIFIER_TIMEOUT_MS,
});

const ALL_ARMS: readonly Arm[] = [
  { family: "native", id: "native" },
  {
    family: "glm5-prompt-only",
    id: "glm5",
    middleware: glm5ToolMiddleware,
  },
  { family: "hermes", id: "hermes", middleware: hermesToolMiddleware },
  { family: "morph", id: "morphXml", middleware: morphXmlToolMiddleware },
  { family: "yaml", id: "yamlXml", middleware: yamlXmlToolMiddleware },
  {
    family: "qwen",
    id: "qwen3Coder",
    middleware: qwen3CoderToolMiddleware,
  },
  {
    family: "morph",
    id: "sijawaraDetailed",
    middleware: sijawaraDetailedXmlToolMiddleware,
  },
  {
    family: "morph",
    id: "sijawaraConcise",
    middleware: sijawaraConciseXmlToolMiddleware,
  },
  { family: "qwen", id: "uiTars", middleware: uiTarsToolMiddleware },
];

function assertDistinctCaptureOutput(
  captureEnabled: boolean,
  captureOut: string
): void {
  if (captureEnabled && captureOut === OUT) {
    throw new Error(
      "MCPMARK_RAW_CAPTURE_OUT/BENCH_RAW_CAPTURE_OUT must differ from MCPMARK_OUT"
    );
  }
}

async function main(): Promise<void> {
  const allTasks = discoverOfficialEasyTasks(MCPMARK_ROOT);
  const tasks = requestedTasks(allTasks);
  const requestedArmIds = requestedValues<ArmId>(
    "MCPMARK_ARMS",
    armIds(ALL_ARMS)
  );
  const arms = ALL_ARMS.filter((arm) => requestedArmIds.includes(arm.id));
  const preparedData = prepareFilesystemData(DATA_ROOT, FILESYSTEM_CATEGORIES);
  const preflight = await preflightFilesystemServer({
    dataRoot: DATA_ROOT,
    requestTimeoutMs: MCP_TIMEOUT_MS,
    snapshotRoot: SNAPSHOT_ROOT,
    task: tasks[0],
  });
  const taskManifest = tasks.map((task) => ({
    category: task.category,
    descriptionHash: task.descriptionHash,
    id: task.id,
    instructionHash: task.instructionHash,
    metaHash: task.metaHash,
    verifierHash: task.verifierHash,
  }));
  const runConfig = {
    arms: arms.map(({ family, id }) => ({ family, id })),
    attemptTimeoutMs: ATTEMPT_TIMEOUT_MS,
    baseUrl: credentialFreeUrl(BASE_URL),
    concurrency: CONCURRENCY,
    data: preparedData.map(({ category, sha256, treeHash }) => ({
      category,
      sha256,
      treeHash,
    })),
    dryRun: DRY_RUN,
    implementationFingerprint: benchmarkImplementationFingerprint(),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    maxTurns: MAX_TURNS,
    mcpRequestTimeoutMs: MCP_TIMEOUT_MS,
    mcpmarkCommit: MCPMARK_COMMIT,
    model: MODEL,
    pairedScheduling: {
      active: hasNativeGlm5Pair(arms),
      arms: ["native", "glm5"],
      method:
        "sequential-worker-batch-per-task-trial-with-hash-alternated-first-arm",
      seed: PAIR_SEED,
    },
    providerTimeoutMs: PROVIDER_TIMEOUT_MS,
    retries: RETRIES,
    rawProviderCapture: EXECUTOR.rawCapture.metadata(),
    runnerRevision: RUNNER_REVISION,
    schemaHash: preflight.schemaHash,
    serverPackage: FILESYSTEM_MCP_PACKAGE,
    snapshotRetention: KEEP_SNAPSHOTS,
    systemPromptHash: sha256Text(SYSTEM_PROMPT),
    tasks: taskManifest,
    temperature: 0,
    transport: TRANSPORT,
    trials: TRIALS,
    verifierTimeoutMs: VERIFIER_TIMEOUT_MS,
  };
  const configFingerprint = sha256Text(stableJson(runConfig));
  const resumeState = prepareResume({
    arms,
    configFingerprint,
    metaOut: META_OUT,
    model: MODEL,
    out: OUT,
    pairSeed: PAIR_SEED,
    resume: RESUME,
    retryFailed: RETRY_FAILED,
    tasks,
    trials: TRIALS,
  });
  const pendingJobs = resumeState.jobBatches.reduce(
    (sum, batch) => sum + batch.length,
    0
  );

  assertDistinctCaptureOutput(
    EXECUTOR.rawCapture.metadata().enabled,
    EXECUTOR.rawCapture.output
  );
  mkdirSync(dirname(OUT), { recursive: true });
  EXECUTOR.rawCapture.prepare(RESUME, resumeState.existing.length > 0);
  initializeResultOutput(OUT, RESUME, RETRY_FAILED, resumeState);
  const startedAt = new Date().toISOString();
  const meta = {
    ...runConfig,
    configFingerprint,
    data: preparedData,
    dataRoot: DATA_ROOT,
    expectedJobs: tasks.length * arms.length * TRIALS,
    mcpmarkRoot: MCPMARK_ROOT,
    officialEasyTaskSet: OFFICIAL_EASY_TASK_IDS,
    output: OUT,
    resumed: RESUME,
    retryFailed: RETRY_FAILED,
    snapshotRoot: SNAPSHOT_ROOT,
    startedAt,
    suiteScope:
      "Adapted MCPMark Filesystem Easy protocol panel with official tasks, datasets, and verifiers; not the 127-task MCPMark Verified leaderboard suite.",
    toolDefinitions: preflight.tools,
  };
  writeFileSync(META_OUT, `${JSON.stringify(meta, null, 2)}\n`);

  console.log(
    `MCPMark Filesystem Easy: ${pendingJobs} pending jobs in ${resumeState.jobBatches.length} worker batches ` +
      `(${tasks.length} tasks x ${arms.length} arms x ${TRIALS} trials), concurrency=${CONCURRENCY}`
  );
  console.log(
    `Pinned source=${MCPMARK_COMMIT.slice(0, 12)} server=${FILESYSTEM_MCP_PACKAGE} schema=${preflight.schemaHash.slice(0, 12)}`
  );
  if (DRY_RUN) {
    console.log(
      `Dry run: ${tasks.length} MCPMark tasks, ${meta.expectedJobs} jobs, no provider calls`
    );
    return;
  }

  await runAndReportBatches({
    concurrency: CONCURRENCY,
    expectedSchemaHash: preflight.schemaHash,
    jobBatches: resumeState.jobBatches,
    out: OUT,
    pendingJobs,
    runJob: EXECUTOR.runJob,
  });
  await EXECUTOR.rawCapture.flush();
  const completedMeta = {
    ...meta,
    completedAt: new Date().toISOString(),
    completedNewJobs: pendingJobs,
    outputSha256: createHash("sha256").update(readFileSync(OUT)).digest("hex"),
  };
  writeFileSync(META_OUT, `${JSON.stringify(completedMeta, null, 2)}\n`);
  console.log(`Completed ${pendingJobs} jobs; raw results: ${OUT}`);
}

main().catch(async (error) => {
  await EXECUTOR.rawCapture.flush();
  console.error(error);
  process.exitCode = 1;
});
