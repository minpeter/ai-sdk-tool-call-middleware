import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import type { LanguageModelV4Middleware } from "@ai-sdk/provider";
import type { benchmarkTransport } from "./benchmark-model-call";
import type {
  OfficialFilesystemTask,
  VerifierResult,
} from "./mcpmark-filesystem-common";
import {
  assertPairedResumeSymmetry,
  hasNativeGlm5Pair,
  pairedArmBatches,
} from "./paired-scheduling";
import type { ProviderCapture } from "./provider-capture";

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
  family: "glm5-prompt-only" | "hermes" | "morph" | "native" | "qwen" | "yaml";
  id: ArmId;
  middleware?: LanguageModelV4Middleware;
}

export interface Job {
  arm: Arm;
  task: OfficialFilesystemTask;
  trial: number;
}

export type FailureStage =
  | "attempt_timeout"
  | "mcp"
  | "parser"
  | "provider"
  | "setup"
  | "turn_limit"
  | "verification";

interface FailureRecord {
  detail: string;
  retryable: boolean;
  stage: FailureStage;
  turn?: number;
}

export interface ToolCallRecord {
  input: unknown;
  latencyMs: number;
  resultHash?: string;
  resultIsError?: boolean;
  rpcError?: string;
  serializedResult?: string;
  toolCallId: string;
  toolName: string;
}

interface TurnRecord {
  assistantMessages: unknown[];
  finishReason: string;
  latencyMs: number;
  parserErrors: string[];
  rawFinishReason?: string;
  text: string;
  toolCalls: ToolCallRecord[];
  turn: number;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

export interface ToolResult {
  output:
    | { type: "error-text"; value: string }
    | { type: "text"; value: string };
  toolCallId: string;
  toolName: string;
  type: "tool-result";
}

export interface TurnContext {
  parserErrors: string[];
  startedAt: number;
  turn: number;
}

export interface AttemptState {
  agentEndedNormally: boolean;
  failures: FailureRecord[];
  fatalAgentFailure: boolean;
  finalText: string;
  parserErrors: string[];
  rawCaptureIds: string[];
  schemaHash?: string;
  serverStderr: string;
  snapshot?: string;
  trajectory: TurnRecord[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

export interface AttemptCompletion {
  attemptNumber: number;
  job: Job;
  startedAt: number;
  state: AttemptState;
}

export interface AttemptRecord {
  agentEndedNormally: boolean;
  attempt: number;
  failures: FailureRecord[];
  finalText: string;
  latencyMs: number;
  mcpServerStderr: string;
  parserErrors: string[];
  rawCaptureIds: string[];
  resultTreeHash?: string;
  schemaHash?: string;
  snapshot?: string;
  snapshotRetained: boolean;
  trajectory: TurnRecord[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  verification: VerifierResult;
}

export interface RunResult {
  arm: ArmId;
  attempts: AttemptRecord[];
  category: string;
  failureStages: FailureStage[];
  jobLatencyMs: number;
  model: string;
  taskId: string;
  transport: "generate" | "stream";
  trial: number;
  verificationPassed: boolean;
}

export type SnapshotRetention = "all" | "failed" | "none";

export interface ExecutionSettings {
  apiKey: string;
  attemptTimeoutMs: number;
  baseUrl: string;
  dataRoot: string;
  maxOutputTokens: number;
  maxTurns: number;
  mcpTimeoutMs: number;
  model: string;
  out: string;
  providerTimeoutMs: number;
  retries: number;
  snapshotRetention: SnapshotRetention;
  snapshotRoot: string;
  systemPrompt: string;
  transport: ReturnType<typeof benchmarkTransport>;
  verifierTimeoutMs: number;
}

export interface McpmarkExecutor {
  rawCapture: ProviderCapture;
  runJob: (job: Job, expectedSchemaHash: string) => Promise<RunResult>;
}

export function emptyVerification(error: string): VerifierResult {
  return {
    error,
    exitCode: null,
    passed: false,
    stderr: "",
    stdout: "",
    timedOut: false,
  };
}

export function shouldRetainAttempt(
  attempt: AttemptRecord,
  retention: SnapshotRetention
): boolean {
  if (!attempt.snapshot) {
    return false;
  }
  if (retention === "all") {
    return true;
  }
  if (retention === "none") {
    return false;
  }
  return !attempt.verification.passed || attempt.failures.length > 0;
}

export function retentionMode(value: string): SnapshotRetention {
  if (value === "0") {
    return "none";
  }
  if (value === "1") {
    return "all";
  }
  if (value === "all" || value === "failed" || value === "none") {
    return value;
  }
  throw new Error("MCPMARK_KEEP_SNAPSHOTS must be all, failed, none, 1, or 0");
}

export function requestedValues<T extends string>(
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

export function requestedTasks(
  allTasks: OfficialFilesystemTask[]
): OfficialFilesystemTask[] {
  const raw = process.env.MCPMARK_TASKS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!raw || raw.length === 0) {
    return allTasks;
  }
  const selected: OfficialFilesystemTask[] = [];
  for (const value of raw) {
    const exact = allTasks.find((task) => task.id === value);
    const matches = exact
      ? [exact]
      : allTasks.filter((task) => task.taskId === value);
    if (matches.length !== 1) {
      throw new Error(
        `MCPMARK_TASKS value ${value} matched ${matches.length} official tasks`
      );
    }
    const [match] = matches;
    if (match && !selected.some((task) => task.id === match.id)) {
      selected.push(match);
    }
  }
  return selected;
}

function jobKey(value: Pick<RunResult, "arm" | "taskId" | "trial">): string {
  return `${value.taskId}\u0000${value.arm}\u0000${value.trial}`;
}

function buildJobBatches(
  tasks: OfficialFilesystemTask[],
  arms: Arm[],
  completed: ReadonlySet<string>,
  trials: number,
  pairSeed: number
): Job[][] {
  const batches: Job[][] = [];
  for (const task of tasks) {
    for (let trial = 1; trial <= trials; trial += 1) {
      const armBatches = pairedArmBatches(
        arms,
        pairSeed,
        `${task.id}\u0000${trial}`
      );
      for (const armBatch of armBatches) {
        const pending = armBatch.flatMap((arm) => {
          const job = { arm, task, trial };
          return completed.has(jobKey({ arm: arm.id, taskId: task.id, trial }))
            ? []
            : [job];
        });
        if (pending.length > 0) {
          batches.push(pending);
        }
      }
    }
  }
  return batches;
}

function assertResumePairSymmetry(
  tasks: readonly OfficialFilesystemTask[],
  arms: readonly Arm[],
  completed: ReadonlySet<string>,
  resume: boolean,
  trials: number
): void {
  if (!(resume && hasNativeGlm5Pair(arms))) {
    return;
  }
  assertPairedResumeSymmetry({
    completed,
    pairs: tasks.flatMap((task) =>
      Array.from({ length: trials }, (_, index) => {
        const trial = index + 1;
        return {
          glm5Key: jobKey({ arm: "glm5", taskId: task.id, trial }),
          identity: `${task.id}/trial-${trial}`,
          nativeKey: jobKey({ arm: "native", taskId: task.id, trial }),
        };
      })
    ),
  });
}

interface ResumeSettings {
  arms: Arm[];
  configFingerprint: string;
  metaOut: string;
  model: string;
  out: string;
  pairSeed: number;
  resume: boolean;
  retryFailed: boolean;
  tasks: OfficialFilesystemTask[];
  trials: number;
}

export interface ResumeState {
  completed: Set<string>;
  existing: RunResult[];
  jobBatches: Job[][];
  latestByKey: Map<string, RunResult>;
}

function loadJsonl(path: string): RunResult[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunResult);
}

export function prepareResume(settings: ResumeSettings): ResumeState {
  let existing: RunResult[] = [];
  if (settings.resume && existsSync(settings.out)) {
    if (!existsSync(settings.metaOut)) {
      throw new Error(
        `Cannot resume ${settings.out}: matching run metadata is missing at ${settings.metaOut}`
      );
    }
    const previousMeta = JSON.parse(readFileSync(settings.metaOut, "utf8")) as {
      configFingerprint?: string;
    };
    if (previousMeta.configFingerprint !== settings.configFingerprint) {
      throw new Error(
        `Cannot resume ${settings.out}: configuration fingerprint mismatch (expected ${settings.configFingerprint}, found ${previousMeta.configFingerprint ?? "missing"})`
      );
    }
    existing = loadJsonl(settings.out);
    const expectedKeys = new Set(
      buildJobBatches(
        settings.tasks,
        settings.arms,
        new Set(),
        settings.trials,
        settings.pairSeed
      ).flatMap((batch) =>
        batch.map((job) =>
          jobKey({ arm: job.arm.id, taskId: job.task.id, trial: job.trial })
        )
      )
    );
    for (const row of existing) {
      if (row.model !== settings.model || !expectedKeys.has(jobKey(row))) {
        throw new Error(
          `Cannot resume ${settings.out}: existing row does not belong to the configured job grid`
        );
      }
    }
  }
  const latestByKey = new Map<string, RunResult>();
  for (const row of existing) {
    latestByKey.set(jobKey(row), row);
  }
  const completed = new Set(
    [...latestByKey]
      .filter(([, row]) => !settings.retryFailed || row.verificationPassed)
      .map(([key]) => key)
  );
  assertResumePairSymmetry(
    settings.tasks,
    settings.arms,
    completed,
    settings.resume,
    settings.trials
  );
  return {
    completed,
    existing,
    jobBatches: buildJobBatches(
      settings.tasks,
      settings.arms,
      completed,
      settings.trials,
      settings.pairSeed
    ),
    latestByKey,
  };
}

export function initializeResultOutput(
  out: string,
  resume: boolean,
  retryFailed: boolean,
  state: ResumeState
): void {
  if (!resume) {
    writeFileSync(out, "");
    return;
  }
  if (retryFailed) {
    const retainedRows = [...state.latestByKey.values()].filter(
      (row) => row.verificationPassed
    );
    writeFileSync(
      out,
      retainedRows.length > 0
        ? `${retainedRows.map((row) => JSON.stringify(row)).join("\n")}\n`
        : ""
    );
    return;
  }
  if (state.existing.length !== state.latestByKey.size) {
    throw new Error(
      `Cannot resume ${out}: duplicate job rows require explicit cleanup`
    );
  }
}

interface RunBatchesSettings {
  concurrency: number;
  expectedSchemaHash: string;
  jobBatches: Job[][];
  out: string;
  pendingJobs: number;
  runJob: (job: Job, expectedSchemaHash: string) => Promise<RunResult>;
}

export async function runAndReportBatches(
  settings: RunBatchesSettings
): Promise<void> {
  let cursor = 0;
  let finished = 0;
  const runStartedAt = Date.now();
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          settings.concurrency,
          Math.max(1, settings.jobBatches.length)
        ),
      },
      async () => {
        while (cursor < settings.jobBatches.length) {
          const index = cursor;
          cursor += 1;
          for (const job of settings.jobBatches[index]) {
            const result = await settings.runJob(
              job,
              settings.expectedSchemaHash
            );
            appendFileSync(settings.out, `${JSON.stringify(result)}\n`);
            finished += 1;
            const elapsed = Math.max((Date.now() - runStartedAt) / 1000, 0.001);
            console.log(
              `[${finished}/${settings.pendingJobs}] ${result.arm} ${result.taskId} ` +
                `${result.verificationPassed ? "PASS" : "FAIL"} ` +
                `attempts=${result.attempts.length} turns=${result.attempts.at(-1)?.trajectory.length ?? 0} ` +
                `failures=${result.failureStages.join(",") || "none"} rate=${(finished / elapsed).toFixed(2)}/s`
            );
          }
        }
      }
    )
  );
}

export function armIds(arms: readonly Arm[]): ArmId[] {
  return arms.map((arm) => arm.id);
}
