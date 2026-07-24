import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
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
  FILESYSTEM_MCP_PACKAGE,
  type McpCallResult,
  McpRpcError,
  McpStdioClient,
  type McpToolDefinition,
} from "./mcp-stdio-client";
import {
  createPristineSnapshot,
  discoverOfficialEasyTasks,
  FILESYSTEM_CATEGORIES,
  hashTree,
  MCPMARK_COMMIT,
  nonNegativeInt,
  OFFICIAL_EASY_TASK_IDS,
  type OfficialFilesystemTask,
  positiveInt,
  preflightFilesystemServer,
  prepareFilesystemData,
  requireEnv,
  resultPathFromOut,
  runOfficialVerifier,
  sha256Text,
  stableJson,
  toolSchemaFingerprint,
  type VerifierResult,
} from "./mcpmark-filesystem-common";
import {
  assertPairedResumeSymmetry,
  hasNativeGlm5Pair,
  pairedArmBatches,
} from "./paired-scheduling";
import {
  captureArmsFromEnv,
  credentialFreeUrl,
  credentialSafeError,
  ProviderCapture,
} from "./provider-capture";
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
const RAW_CAPTURE = new ProviderCapture({
  arms: captureArmsFromEnv(
    process.env.MCPMARK_RAW_CAPTURE_ARMS ?? process.env.BENCH_RAW_CAPTURE_ARMS
  ),
  enabled:
    (process.env.MCPMARK_RAW_CAPTURE ?? process.env.BENCH_RAW_CAPTURE) !== "0",
  output: resolve(
    process.env.MCPMARK_RAW_CAPTURE_OUT ??
      process.env.BENCH_RAW_CAPTURE_OUT ??
      join(dirname(OUT), "provider-raw.jsonl")
  ),
  secretValues: [API_KEY],
});
const RUNNER_REVISION = 5;

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
  family: "glm5-prompt-only" | "hermes" | "morph" | "native" | "qwen" | "yaml";
  id: ArmId;
  middleware?: LanguageModelV4Middleware;
}

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

type FailureStage =
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

interface ToolCallRecord {
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

interface AttemptRecord {
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

interface RunResult {
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

interface Job {
  arm: Arm;
  task: OfficialFilesystemTask;
  trial: number;
}

type SnapshotRetention = "all" | "failed" | "none";

const KEEP_SNAPSHOTS = retentionMode(
  process.env.MCPMARK_KEEP_SNAPSHOTS ?? "failed"
);

const SYSTEM_PROMPT =
  "You are a helpful agent that uses tools iteratively to complete the user's task, " +
  'and when finished, provides the final answer or simply states "Task completed" without further tool calls.';

function normalizeError(error: unknown): string {
  return credentialSafeError(error, [API_KEY]);
}

const provider = createOpenAICompatible({
  apiKey: API_KEY,
  baseURL: BASE_URL,
  name: "freerouter",
  fetch: RAW_CAPTURE.fetch,
});

function retentionMode(value: string): SnapshotRetention {
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

function requestedTasks(
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
    if (!selected.some((task) => task.id === matches[0].id)) {
      selected.push(matches[0]);
    }
  }
  return selected;
}

function makeTools(definitions: McpToolDefinition[]): ToolSet {
  const tools: ToolSet = {};
  for (const definition of definitions) {
    tools[definition.name] = {
      description: definition.description,
      inputSchema: jsonSchema(definition.inputSchema),
    };
  }
  return tools;
}

function makeModel(arm: Arm) {
  const model = provider(MODEL);
  return arm.middleware
    ? wrapLanguageModel({ middleware: arm.middleware, model })
    : model;
}

function collectParserErrors(errors: string[]) {
  return {
    toolCallMiddleware: {
      onError: (message: string, metadata?: Record<string, unknown>) => {
        errors.push(
          `${message}${metadata ? ` ${JSON.stringify(metadata).slice(0, 2000)}` : ""}`
        );
      },
    },
  };
}

function addFailure(
  failures: FailureRecord[],
  stage: FailureStage,
  detail: string,
  retryable: boolean,
  turn?: number
): void {
  failures.push({ detail: detail.slice(0, 8000), retryable, stage, turn });
}

function syntheticRpcError(error: McpRpcError): McpCallResult {
  return {
    content: [{ type: "text", text: `Error: ${error.message}` }],
    isError: true,
    rpcError: {
      code: error.code,
      data: error.data,
      message: error.message,
    },
  };
}

function emptyVerification(error: string): VerifierResult {
  return {
    error,
    exitCode: null,
    passed: false,
    stderr: "",
    stdout: "",
    timedOut: false,
  };
}

function shouldRetainAttempt(attempt: AttemptRecord): boolean {
  if (!attempt.snapshot) {
    return false;
  }
  if (KEEP_SNAPSHOTS === "all") {
    return true;
  }
  if (KEEP_SNAPSHOTS === "none") {
    return false;
  }
  return !attempt.verification.passed || attempt.failures.length > 0;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This is the auditable attempt state machine; extracting branches would obscure ordered setup, tool execution, teardown, and mandatory verification.
async function runAttempt(
  job: Job,
  attemptNumber: number,
  expectedSchemaHash: string
): Promise<AttemptRecord> {
  const startedAt = Date.now();
  const deadline = startedAt + ATTEMPT_TIMEOUT_MS;
  const failures: FailureRecord[] = [];
  const parserErrors: string[] = [];
  const rawCaptureIds: string[] = [];
  const trajectory: TurnRecord[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let snapshot: string | undefined;
  let client: McpStdioClient | undefined;
  let schemaHash: string | undefined;
  let serverStderr = "";
  let finalText = "";
  let agentEndedNormally = false;
  let fatalAgentFailure = false;

  try {
    snapshot = createPristineSnapshot(
      join(DATA_ROOT, job.task.category),
      SNAPSHOT_ROOT,
      `${job.task.category}-${job.task.taskId}-${job.arm.id}-trial${job.trial}-attempt${attemptNumber}`
    );
    client = await McpStdioClient.connect({
      allowedRoot: snapshot,
      requestTimeoutMs: MCP_TIMEOUT_MS,
    });
    const definitions = await client.listTools();
    schemaHash = toolSchemaFingerprint(definitions);
    if (schemaHash !== expectedSchemaHash) {
      throw new Error(
        `MCP schema drift: expected ${expectedSchemaHash}, got ${schemaHash}`
      );
    }

    const model = makeModel(job.arm);
    const tools = makeTools(definitions);
    const captureTools = definitions.map(
      ({ description, inputSchema, name }) => ({
        description,
        inputSchema,
        name,
      })
    );
    const messages: ModelMessage[] = [
      { content: job.task.instruction, role: "user" },
    ];

    for (let turn = 1; turn <= MAX_TURNS; turn += 1) {
      if (Date.now() >= deadline) {
        addFailure(
          failures,
          "attempt_timeout",
          `Agent attempt exceeded ${ATTEMPT_TIMEOUT_MS}ms`,
          false,
          turn
        );
        fatalAgentFailure = true;
        break;
      }
      const turnStartedAt = Date.now();
      const turnParserErrors: string[] = [];
      let result: Awaited<ReturnType<typeof runBenchmarkModel>>;
      try {
        result = await RAW_CAPTURE.run(
          {
            arm: job.arm.id,
            attempt: attemptNumber,
            category: job.task.category,
            jobKey: `${job.task.id}\u0000${job.arm.id}\u0000${job.trial}`,
            suite: "mcpmark",
            taskId: job.task.id,
            tools: captureTools,
            transport: TRANSPORT,
            trial: job.trial,
            turn,
          },
          rawCaptureIds,
          () =>
            runBenchmarkModel(
              {
                abortSignal: AbortSignal.timeout(
                  Math.max(
                    1,
                    Math.min(PROVIDER_TIMEOUT_MS, deadline - Date.now())
                  )
                ),
                instructions: SYSTEM_PROMPT,
                maxOutputTokens: MAX_OUTPUT_TOKENS,
                maxRetries: 0,
                messages,
                model,
                providerOptions: job.arm.middleware
                  ? (collectParserErrors(turnParserErrors) as never)
                  : undefined,
                temperature: 0,
                toolChoice: "auto",
                tools,
              },
              TRANSPORT
            )
        );
      } catch (error) {
        parserErrors.push(...turnParserErrors);
        if (Date.now() >= deadline) {
          if (turnParserErrors.length > 0) {
            addFailure(
              failures,
              "parser",
              turnParserErrors.join(" | "),
              false,
              turn
            );
          }
          addFailure(
            failures,
            "attempt_timeout",
            `Agent attempt exceeded ${ATTEMPT_TIMEOUT_MS}ms: ${normalizeError(error)}`,
            false,
            turn
          );
        } else if (turnParserErrors.length > 0) {
          addFailure(
            failures,
            "parser",
            `${turnParserErrors.join(" | ")} | ${normalizeError(error)}`,
            false,
            turn
          );
        } else {
          addFailure(failures, "provider", normalizeError(error), true, turn);
        }
        fatalAgentFailure = true;
        break;
      }

      parserErrors.push(...turnParserErrors);
      if (turnParserErrors.length > 0) {
        addFailure(
          failures,
          "parser",
          turnParserErrors.join(" | "),
          false,
          turn
        );
      }

      usage.inputTokens += result.usage.inputTokens ?? 0;
      usage.outputTokens += result.usage.outputTokens ?? 0;
      usage.totalTokens += result.usage.totalTokens ?? 0;
      finalText = result.text;
      const assistantMessages = result.responseMessages.filter(
        (message) => message.role === "assistant"
      );
      messages.push(...assistantMessages);
      const toolCallRecords: ToolCallRecord[] = [];
      const toolResults: Array<{
        output:
          | { type: "error-text"; value: string }
          | { type: "text"; value: string };
        toolCallId: string;
        toolName: string;
        type: "tool-result";
      }> = [];

      for (const call of result.toolCalls) {
        const callStartedAt = Date.now();
        const record: ToolCallRecord = {
          input: call.input,
          latencyMs: 0,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
        };
        if (call.invalid === true) {
          const detail = `Invalid AI SDK tool call ${call.toolName}: ${normalizeError(call.error)}`;
          record.resultIsError = true;
          record.rpcError = detail;
          record.serializedResult = JSON.stringify({ error: detail });
          record.resultHash = sha256Text(record.serializedResult);
          parserErrors.push(detail);
          turnParserErrors.push(detail);
          addFailure(failures, "parser", detail, false, turn);
          toolResults.push({
            output: { type: "error-text", value: detail },
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            type: "tool-result",
          });
          toolCallRecords.push(record);
          continue;
        }
        if (Date.now() >= deadline) {
          addFailure(
            failures,
            "attempt_timeout",
            `Agent attempt exceeded ${ATTEMPT_TIMEOUT_MS}ms before MCP execution`,
            false,
            turn
          );
          fatalAgentFailure = true;
          toolCallRecords.push(record);
          break;
        }
        try {
          const mcpResult = await client.callTool(
            call.toolName,
            call.input as Record<string, unknown>,
            Math.max(1, Math.min(MCP_TIMEOUT_MS, deadline - Date.now()))
          );
          const serialized = JSON.stringify(mcpResult);
          record.latencyMs = Date.now() - callStartedAt;
          record.resultHash = sha256Text(serialized);
          record.resultIsError = mcpResult.isError === true;
          record.serializedResult = serialized;
          if (mcpResult.isError) {
            addFailure(
              failures,
              "mcp",
              `Tool ${call.toolName} returned isError=true`,
              false,
              turn
            );
          }
          toolResults.push({
            output: { type: "text", value: serialized },
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            type: "tool-result",
          });
        } catch (error) {
          record.latencyMs = Date.now() - callStartedAt;
          if (error instanceof McpRpcError) {
            const mcpResult = syntheticRpcError(error);
            const serialized = JSON.stringify(mcpResult);
            record.resultHash = sha256Text(serialized);
            record.resultIsError = true;
            record.rpcError = error.message;
            record.serializedResult = serialized;
            addFailure(failures, "mcp", error.message, false, turn);
            toolResults.push({
              output: { type: "text", value: serialized },
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              type: "tool-result",
            });
          } else {
            const detail = normalizeError(error);
            record.rpcError = detail;
            if (Date.now() >= deadline) {
              addFailure(
                failures,
                "attempt_timeout",
                `Agent attempt exceeded ${ATTEMPT_TIMEOUT_MS}ms during MCP execution: ${detail}`,
                false,
                turn
              );
            } else {
              addFailure(failures, "mcp", detail, true, turn);
            }
            fatalAgentFailure = true;
          }
        }
        toolCallRecords.push(record);
        if (fatalAgentFailure) {
          break;
        }
      }

      trajectory.push({
        assistantMessages,
        finishReason: result.finishReason,
        latencyMs: Date.now() - turnStartedAt,
        parserErrors: turnParserErrors,
        rawFinishReason: result.rawFinishReason,
        text: result.text,
        toolCalls: toolCallRecords,
        turn,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
        },
      });

      if (fatalAgentFailure) {
        break;
      }
      if (result.toolCalls.length === 0) {
        agentEndedNormally = true;
        break;
      }
      messages.push({ content: toolResults, role: "tool" });
    }

    if (!(agentEndedNormally || fatalAgentFailure)) {
      addFailure(
        failures,
        "turn_limit",
        `Agent still requested tools after ${MAX_TURNS} turns`,
        false,
        MAX_TURNS
      );
    }
  } catch (error) {
    addFailure(failures, "setup", normalizeError(error), true);
  } finally {
    serverStderr = client?.stderr() ?? "";
    await client?.close();
  }

  let verification: VerifierResult;
  if (snapshot && existsSync(snapshot)) {
    verification = runOfficialVerifier(job.task, snapshot, VERIFIER_TIMEOUT_MS);
  } else {
    verification = emptyVerification(
      "Official verifier could not run because no snapshot was available"
    );
  }
  if (!verification.passed) {
    addFailure(
      failures,
      "verification",
      verification.error ||
        verification.stderr ||
        verification.stdout ||
        "Official verifier returned non-zero",
      false
    );
  }

  let resultTreeHash: string | undefined;
  if (snapshot && existsSync(snapshot)) {
    try {
      resultTreeHash = hashTree(snapshot);
    } catch (error) {
      addFailure(
        failures,
        "setup",
        `Could not hash result tree: ${normalizeError(error)}`,
        true
      );
    }
  }

  const attempt: AttemptRecord = {
    agentEndedNormally,
    attempt: attemptNumber,
    failures,
    finalText,
    latencyMs: Date.now() - startedAt,
    mcpServerStderr: serverStderr,
    parserErrors,
    rawCaptureIds,
    resultTreeHash,
    schemaHash,
    snapshot,
    snapshotRetained: false,
    trajectory,
    usage,
    verification,
  };
  attempt.snapshotRetained = shouldRetainAttempt(attempt);
  if (snapshot && !attempt.snapshotRetained) {
    rmSync(snapshot, { force: true, recursive: true });
  }
  return attempt;
}

async function runJob(
  job: Job,
  expectedSchemaHash: string
): Promise<RunResult> {
  const startedAt = Date.now();
  const attempts: AttemptRecord[] = [];
  for (
    let attemptNumber = 1;
    attemptNumber <= RETRIES + 1;
    attemptNumber += 1
  ) {
    const attempt = await runAttempt(job, attemptNumber, expectedSchemaHash);
    attempts.push(attempt);
    const retryable = attempt.failures.some((failure) => failure.retryable);
    if (attempt.verification.passed || !retryable) {
      break;
    }
  }
  const finalAttempt = attempts.at(-1);
  if (!finalAttempt) {
    throw new Error("runJob produced no attempts");
  }
  return {
    arm: job.arm.id,
    attempts,
    category: job.task.category,
    failureStages: [
      ...new Set(
        attempts.flatMap((attempt) =>
          attempt.failures.map((failure) => failure.stage)
        )
      ),
    ],
    jobLatencyMs: Date.now() - startedAt,
    model: MODEL,
    taskId: job.task.id,
    trial: job.trial,
    transport: TRANSPORT,
    verificationPassed: finalAttempt.verification.passed,
  };
}

function jobKey(value: Pick<RunResult, "arm" | "taskId" | "trial">): string {
  return `${value.taskId}\u0000${value.arm}\u0000${value.trial}`;
}

function loadJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function buildJobBatches(
  tasks: OfficialFilesystemTask[],
  arms: Arm[],
  completed: ReadonlySet<string>
): Job[][] {
  const batches: Job[][] = [];
  for (const task of tasks) {
    for (let trial = 1; trial <= TRIALS; trial += 1) {
      const armBatches = pairedArmBatches(
        arms,
        PAIR_SEED,
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

function assertDistinctCaptureOutput(): void {
  if (RAW_CAPTURE.metadata().enabled && RAW_CAPTURE.output === OUT) {
    throw new Error(
      "MCPMARK_RAW_CAPTURE_OUT/BENCH_RAW_CAPTURE_OUT must differ from MCPMARK_OUT"
    );
  }
}

function assertResumePairSymmetry(
  tasks: readonly OfficialFilesystemTask[],
  arms: readonly Arm[],
  completed: ReadonlySet<string>
): void {
  if (!(RESUME && hasNativeGlm5Pair(arms))) {
    return;
  }
  assertPairedResumeSymmetry({
    completed,
    pairs: tasks.flatMap((task) =>
      Array.from({ length: TRIALS }, (_, index) => {
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

async function main(): Promise<void> {
  const allTasks = discoverOfficialEasyTasks(MCPMARK_ROOT);
  const tasks = requestedTasks(allTasks);
  const requestedArmIds = requestedValues<ArmId>(
    "MCPMARK_ARMS",
    ALL_ARMS.map((arm) => arm.id)
  );
  const arms = ALL_ARMS.filter((arm) => requestedArmIds.includes(arm.id));

  // Prepare and hash every official Easy dataset, even for filtered smoke runs.
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
    rawProviderCapture: RAW_CAPTURE.metadata(),
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

  let existing: RunResult[] = [];
  if (RESUME && existsSync(OUT)) {
    if (!existsSync(META_OUT)) {
      throw new Error(
        `Cannot resume ${OUT}: matching run metadata is missing at ${META_OUT}`
      );
    }
    const previousMeta = JSON.parse(readFileSync(META_OUT, "utf8")) as {
      configFingerprint?: string;
    };
    if (previousMeta.configFingerprint !== configFingerprint) {
      throw new Error(
        `Cannot resume ${OUT}: configuration fingerprint mismatch (expected ${configFingerprint}, found ${previousMeta.configFingerprint ?? "missing"})`
      );
    }
    existing = loadJsonl<RunResult>(OUT);
    const expectedKeys = new Set(
      buildJobBatches(tasks, arms, new Set()).flatMap((batch) =>
        batch.map((job) =>
          jobKey({ arm: job.arm.id, taskId: job.task.id, trial: job.trial })
        )
      )
    );
    for (const row of existing) {
      if (row.model !== MODEL || !expectedKeys.has(jobKey(row))) {
        throw new Error(
          `Cannot resume ${OUT}: existing row does not belong to the configured job grid`
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
      .filter(([, row]) => !RETRY_FAILED || row.verificationPassed)
      .map(([key]) => key)
  );
  assertResumePairSymmetry(tasks, arms, completed);
  const jobBatches = buildJobBatches(tasks, arms, completed);
  const pendingJobs = jobBatches.reduce((sum, batch) => sum + batch.length, 0);

  assertDistinctCaptureOutput();
  mkdirSync(dirname(OUT), { recursive: true });
  RAW_CAPTURE.prepare(RESUME, existing.length > 0);
  if (!RESUME) {
    writeFileSync(OUT, "");
  } else if (RETRY_FAILED) {
    const retainedRows = [...latestByKey.values()].filter(
      (row) => row.verificationPassed
    );
    writeFileSync(
      OUT,
      retainedRows.length > 0
        ? `${retainedRows.map((row) => JSON.stringify(row)).join("\n")}\n`
        : ""
    );
  } else if (existing.length !== latestByKey.size) {
    throw new Error(
      `Cannot resume ${OUT}: duplicate job rows require explicit cleanup`
    );
  }
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
    `MCPMark Filesystem Easy: ${pendingJobs} pending jobs in ${jobBatches.length} worker batches ` +
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

  let cursor = 0;
  let finished = 0;
  const runStartedAt = Date.now();
  await Promise.all(
    Array.from(
      { length: Math.min(CONCURRENCY, Math.max(1, jobBatches.length)) },
      async () => {
        while (cursor < jobBatches.length) {
          const index = cursor;
          cursor += 1;
          for (const job of jobBatches[index]) {
            const result = await runJob(job, preflight.schemaHash);
            appendFileSync(OUT, `${JSON.stringify(result)}\n`);
            finished += 1;
            const elapsed = Math.max((Date.now() - runStartedAt) / 1000, 0.001);
            console.log(
              `[${finished}/${pendingJobs}] ${result.arm} ${result.taskId} ` +
                `${result.verificationPassed ? "PASS" : "FAIL"} ` +
                `attempts=${result.attempts.length} turns=${result.attempts.at(-1)?.trajectory.length ?? 0} ` +
                `failures=${result.failureStages.join(",") || "none"} rate=${(finished / elapsed).toFixed(2)}/s`
            );
          }
        }
      }
    )
  );

  await RAW_CAPTURE.flush();

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
  await RAW_CAPTURE.flush();
  console.error(error);
  process.exitCode = 1;
});
