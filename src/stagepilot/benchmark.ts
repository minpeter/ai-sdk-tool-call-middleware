import { performance } from "node:perf_hooks";
import type {
  LanguageModelV3Content,
  LanguageModelV3FunctionTool,
} from "@ai-sdk/provider";
import { hermesProtocol } from "../core/protocols/hermes-protocol";
import { recoverToolCallFromJsonCandidates } from "../core/utils/generated-text-json-recovery";
import { coerceBySchema } from "../schema-coerce/index";
import { StagePilotEngine } from "./orchestrator";
import type { IntakeInput, RiskType, UrgencyLevel } from "./types";

type MutationMode =
  | "coercible-types"
  | "garbage-tail"
  | "missing-brace"
  | "no-tags"
  | "prefixed-valid"
  | "relaxed-json"
  | "strict";

export type BenchmarkStrategy =
  | "baseline"
  | "middleware"
  | "middleware+ralph-loop";

export interface StagePilotBenchmarkCase {
  attempts: string[];
  id: string;
  mode: MutationMode;
}

export interface StagePilotBenchmarkStrategyMetrics {
  avgAttemptsUsed: number;
  avgLatencyMs: number;
  failedCaseIds: string[];
  p95LatencyMs: number;
  parseSuccessCount: number;
  planSuccessCount: number;
  strategy: BenchmarkStrategy;
  successRate: number;
  totalCases: number;
}

export interface StagePilotBenchmarkReport {
  caseCount: number;
  generatedAt: string;
  improvements: {
    loopVsBaseline: number;
    loopVsMiddleware: number;
    middlewareVsBaseline: number;
  };
  seed: number;
  strategies: StagePilotBenchmarkStrategyMetrics[];
}

export interface StagePilotBenchmarkOptions {
  caseCount?: number;
  maxLoopAttempts?: number;
  seed?: number;
}

const TOOL_NAME = "route_case";
const TOOL_CALL_SEGMENT_REGEX = /<tool_call>([\s\S]*?)<\/tool_call>/s;

const RISK_TYPES: RiskType[] = [
  "housing",
  "food",
  "income",
  "isolation",
  "care",
  "other",
];
const URGENCY_LEVELS: UrgencyLevel[] = ["high", "medium", "low"];
const DISTRICTS = ["Gangbuk-gu", "Jungnang-gu", "Seocho-gu"];
const MUTATION_SEQUENCE: MutationMode[] = [
  "strict",
  "relaxed-json",
  "coercible-types",
  "missing-brace",
  "no-tags",
  "garbage-tail",
  "prefixed-valid",
];
const TOOL_INPUT_SCHEMA = {
  additionalProperties: true,
  properties: {
    caseId: { type: "string" },
    contactWindow: { type: "string" },
    district: { type: "string" },
    notes: { type: "string" },
    risks: {
      items: { type: "string" },
      type: "array",
    },
    urgencyHint: { enum: URGENCY_LEVELS, type: "string" },
  },
  required: ["caseId", "district", "notes", "risks"],
  type: "object",
};
const TOOL_DEFINITIONS: LanguageModelV3FunctionTool[] = [
  {
    inputSchema: TOOL_INPUT_SCHEMA,
    name: TOOL_NAME,
    type: "function",
  },
];
const HERMES_PROTOCOL = hermesProtocol();

interface CaseToolArguments {
  caseId: string;
  contactWindow?: string;
  district: string;
  notes: string;
  risks: RiskType[];
  urgencyHint: UrgencyLevel;
}

interface StrategyExecutionResult {
  attemptsUsed: number;
  parsedInput: IntakeInput | null;
}

interface BenchmarkContext {
  cases: StagePilotBenchmarkCase[];
  maxLoopAttempts: number;
}

function toTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100;
}

function createSeededRandom(seed: number): () => number {
  let state = Math.abs(Math.trunc(seed)) % 4_294_967_296;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

function sampleUniqueRisks(
  random: () => number,
  desiredCount: number
): RiskType[] {
  const pool = [...RISK_TYPES];
  const picked: RiskType[] = [];

  while (picked.length < desiredCount && pool.length > 0) {
    const index = Math.floor(random() * pool.length);
    const [risk] = pool.splice(index, 1);
    if (risk) {
      picked.push(risk);
    }
  }

  return picked.length > 0 ? picked : ["other"];
}

function renderCanonicalToolCall(args: CaseToolArguments): string {
  return `<tool_call>${JSON.stringify({
    arguments: args,
    name: TOOL_NAME,
  })}</tool_call>`;
}

function renderRelaxedToolCall(args: CaseToolArguments): string {
  const risks = args.risks.map((risk) => `'${risk}'`).join(", ");
  return `<tool_call>{name:'${TOOL_NAME}',arguments:{caseId:'${args.caseId}',district:'${args.district}',notes:'${args.notes}',risks:[${risks}],urgencyHint:'${args.urgencyHint}',contactWindow:'${args.contactWindow ?? "18:00-21:00"}'}}</tool_call>`;
}

function buildPrimaryAttempt(
  mode: MutationMode,
  args: CaseToolArguments
): string {
  const canonical = renderCanonicalToolCall(args);

  switch (mode) {
    case "strict":
      return canonical;
    case "prefixed-valid":
      return `Operator note: case queued.\n${canonical}\nDispatch complete.`;
    case "relaxed-json":
      return renderRelaxedToolCall(args);
    case "coercible-types": {
      const typedMismatch = {
        caseId: Number(args.caseId.replace(/\D/g, "")) || 1,
        contactWindow: 1800,
        district: args.district,
        notes: 404,
        risks: args.risks[0],
        urgencyHint: args.urgencyHint,
      };
      return `<tool_call>${JSON.stringify({
        arguments: typedMismatch,
        name: TOOL_NAME,
      })}</tool_call>`;
    }
    case "missing-brace": {
      const json = JSON.stringify({
        arguments: args,
        name: TOOL_NAME,
      });
      return `<tool_call>${json.slice(0, -1)}</tool_call>`;
    }
    case "garbage-tail": {
      const json = JSON.stringify({
        arguments: args,
        name: TOOL_NAME,
      });
      return `<tool_call>${json} trailing_tokens</tool_call>`;
    }
    case "no-tags":
      return JSON.stringify({
        arguments: args,
        name: TOOL_NAME,
      });
    default:
      return canonical;
  }
}

function buildCaseToolArguments(
  index: number,
  random: () => number
): CaseToolArguments {
  const riskCount = 1 + Math.floor(random() * 3);
  const urgency = URGENCY_LEVELS[Math.floor(random() * URGENCY_LEVELS.length)];
  const district = DISTRICTS[Math.floor(random() * DISTRICTS.length)];
  const risks = sampleUniqueRisks(random, riskCount);
  const primaryRisk = risks[0] ?? "other";

  return {
    caseId: `bench-${index + 1}`,
    contactWindow: "18:00-21:00",
    district,
    notes: `Case ${index + 1} requires ${primaryRisk} support routing.`,
    risks,
    urgencyHint: urgency ?? "medium",
  };
}

export function createBenchmarkCases(
  caseCount: number,
  seed: number
): StagePilotBenchmarkCase[] {
  const random = createSeededRandom(seed);
  const cases: StagePilotBenchmarkCase[] = [];

  for (let index = 0; index < caseCount; index += 1) {
    const args = buildCaseToolArguments(index, random);
    const mode =
      MUTATION_SEQUENCE[index % MUTATION_SEQUENCE.length] ?? "strict";
    const firstAttempt = buildPrimaryAttempt(mode, args);
    const secondAttempt = renderCanonicalToolCall(args);

    cases.push({
      attempts: [firstAttempt, secondAttempt],
      id: args.caseId,
      mode,
    });
  }

  return cases;
}

function normalizeRisks(value: unknown): RiskType[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  if (value.length === 0) {
    return null;
  }

  const normalized = value
    .map((risk) => String(risk).trim().toLowerCase())
    .map((risk) => {
      return RISK_TYPES.includes(risk as RiskType)
        ? (risk as RiskType)
        : "other";
    });

  return normalized;
}

function toIntakeInput(
  args: unknown,
  options: { coerce: boolean }
): IntakeInput | null {
  const prepared = options.coerce
    ? coerceBySchema(args, TOOL_INPUT_SCHEMA)
    : args;
  if (!prepared || typeof prepared !== "object") {
    return null;
  }

  const record = prepared as Record<string, unknown>;
  const caseId = record.caseId;
  const district = record.district;
  const notes = record.notes;
  const risks = normalizeRisks(record.risks);
  const contactWindow = record.contactWindow;
  const urgency = record.urgencyHint;

  if (
    typeof caseId !== "string" ||
    typeof district !== "string" ||
    typeof notes !== "string" ||
    !risks
  ) {
    return null;
  }

  const normalizedUrgency = URGENCY_LEVELS.includes(urgency as UrgencyLevel)
    ? (urgency as UrgencyLevel)
    : "medium";

  return {
    caseId,
    contactWindow:
      typeof contactWindow === "string" && contactWindow.length > 0
        ? contactWindow
        : undefined,
    district,
    notes,
    risks,
    urgencyHint: normalizedUrgency,
  };
}

function parseWithBaseline(text: string): IntakeInput | null {
  const match = TOOL_CALL_SEGMENT_REGEX.exec(text);
  if (!match?.[1]) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const candidate = parsed as {
    arguments?: unknown;
    name?: unknown;
  };

  if (candidate.name !== TOOL_NAME) {
    return null;
  }

  return toIntakeInput(candidate.arguments, { coerce: false });
}

function parseWithMiddleware(text: string): IntakeInput | null {
  const parsed = HERMES_PROTOCOL.parseGeneratedText({
    text,
    tools: TOOL_DEFINITIONS,
  });

  const parsedByProtocol = parseIntakeFromToolCallParts(parsed);
  if (parsedByProtocol) {
    return parsedByProtocol;
  }

  // Recovery path for untagged JSON or tagged payloads with trailing tokens.
  const recovered = recoverToolCallFromJsonCandidates(text, TOOL_DEFINITIONS);
  if (recovered) {
    return parseIntakeFromToolCallParts(recovered);
  }

  return null;
}

function parseIntakeFromToolCallParts(
  parts: LanguageModelV3Content[]
): IntakeInput | null {
  for (const part of parts) {
    if (part.type !== "tool-call" || part.toolName !== TOOL_NAME) {
      continue;
    }

    let input: unknown;
    try {
      input = JSON.parse(part.input);
    } catch {
      continue;
    }

    const normalized = toIntakeInput(input, { coerce: true });
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function executeStrategy(
  strategy: BenchmarkStrategy,
  benchmarkCase: StagePilotBenchmarkCase,
  context: BenchmarkContext
): StrategyExecutionResult {
  if (strategy === "baseline") {
    const first = benchmarkCase.attempts[0] ?? "";
    return {
      attemptsUsed: 1,
      parsedInput: parseWithBaseline(first),
    };
  }

  const attempts =
    strategy === "middleware"
      ? benchmarkCase.attempts.slice(0, 1)
      : benchmarkCase.attempts.slice(0, context.maxLoopAttempts);

  let attemptsUsed = 0;
  for (const attempt of attempts) {
    attemptsUsed += 1;
    const parsedInput = parseWithMiddleware(attempt);
    if (parsedInput) {
      return {
        attemptsUsed,
        parsedInput,
      };
    }
  }

  return {
    attemptsUsed: attempts.length,
    parsedInput: null,
  };
}

function summarizeLatencies(latencies: number[]): {
  avgLatencyMs: number;
  p95LatencyMs: number;
} {
  if (latencies.length === 0) {
    return {
      avgLatencyMs: 0,
      p95LatencyMs: 0,
    };
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const avg =
    sorted.reduce((sum, current) => sum + current, 0) /
    Math.max(1, sorted.length);
  const p95Index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * 0.95) - 1
  );
  const p95 = sorted[Math.max(0, p95Index)] ?? 0;

  return {
    avgLatencyMs: toTwoDecimals(avg),
    p95LatencyMs: toTwoDecimals(p95),
  };
}

async function runStrategyBenchmark(
  strategy: BenchmarkStrategy,
  context: BenchmarkContext
): Promise<StagePilotBenchmarkStrategyMetrics> {
  const engine = new StagePilotEngine();
  const latencies: number[] = [];
  const failedCaseIds: string[] = [];

  let parseSuccessCount = 0;
  let planSuccessCount = 0;
  let attemptsSum = 0;

  for (const benchmarkCase of context.cases) {
    const start = performance.now();
    const execution = executeStrategy(strategy, benchmarkCase, context);
    attemptsSum += execution.attemptsUsed;

    if (execution.parsedInput) {
      parseSuccessCount += 1;
      await engine.run(execution.parsedInput);
      planSuccessCount += 1;
    } else {
      failedCaseIds.push(benchmarkCase.id);
    }

    latencies.push(performance.now() - start);
  }

  const latency = summarizeLatencies(latencies);
  const totalCases = context.cases.length;
  const successRate = totalCases
    ? toTwoDecimals((planSuccessCount / totalCases) * 100)
    : 0;

  return {
    avgAttemptsUsed: toTwoDecimals(attemptsSum / Math.max(totalCases, 1)),
    avgLatencyMs: latency.avgLatencyMs,
    failedCaseIds,
    p95LatencyMs: latency.p95LatencyMs,
    parseSuccessCount,
    planSuccessCount,
    strategy,
    successRate,
    totalCases,
  };
}

function findStrategy(
  strategies: StagePilotBenchmarkStrategyMetrics[],
  strategy: BenchmarkStrategy
): StagePilotBenchmarkStrategyMetrics {
  const found = strategies.find((item) => item.strategy === strategy);
  if (!found) {
    throw new Error(`Missing benchmark strategy result: ${strategy}`);
  }
  return found;
}

export async function benchmarkStagePilotStrategies(
  options: StagePilotBenchmarkOptions = {}
): Promise<StagePilotBenchmarkReport> {
  const caseCount = Math.max(1, options.caseCount ?? 24);
  const seed = options.seed ?? 20_260_228;
  const maxLoopAttempts = Math.max(2, options.maxLoopAttempts ?? 2);
  const cases = createBenchmarkCases(caseCount, seed);
  const context: BenchmarkContext = {
    cases,
    maxLoopAttempts,
  };

  const strategies: StagePilotBenchmarkStrategyMetrics[] = [];
  for (const strategy of [
    "baseline",
    "middleware",
    "middleware+ralph-loop",
  ] as const) {
    strategies.push(await runStrategyBenchmark(strategy, context));
  }

  const baseline = findStrategy(strategies, "baseline");
  const middleware = findStrategy(strategies, "middleware");
  const loop = findStrategy(strategies, "middleware+ralph-loop");

  return {
    caseCount,
    generatedAt: new Date().toISOString(),
    improvements: {
      loopVsBaseline: toTwoDecimals(loop.successRate - baseline.successRate),
      loopVsMiddleware: toTwoDecimals(
        loop.successRate - middleware.successRate
      ),
      middlewareVsBaseline: toTwoDecimals(
        middleware.successRate - baseline.successRate
      ),
    },
    seed,
    strategies,
  };
}

export function formatBenchmarkSummary(
  report: StagePilotBenchmarkReport
): string {
  const lines = [
    "# StagePilot Benchmark Summary",
    "",
    `- Generated at: ${report.generatedAt}`,
    `- Cases: ${report.caseCount}`,
    `- Seed: ${report.seed}`,
    "",
    "| Strategy | Parse Success | Plan Success | Success Rate (%) | Avg Latency (ms) | P95 Latency (ms) | Avg Attempts |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];

  for (const strategy of report.strategies) {
    lines.push(
      `| ${strategy.strategy} | ${strategy.parseSuccessCount}/${strategy.totalCases} | ${strategy.planSuccessCount}/${strategy.totalCases} | ${strategy.successRate.toFixed(2)} | ${strategy.avgLatencyMs.toFixed(2)} | ${strategy.p95LatencyMs.toFixed(2)} | ${strategy.avgAttemptsUsed.toFixed(2)} |`
    );
  }

  lines.push("");
  lines.push("## Improvement");
  lines.push(
    `- Middleware vs Baseline: +${report.improvements.middlewareVsBaseline.toFixed(2)}pp`
  );
  lines.push(
    `- Loop vs Middleware: +${report.improvements.loopVsMiddleware.toFixed(2)}pp`
  );
  lines.push(
    `- Loop vs Baseline: +${report.improvements.loopVsBaseline.toFixed(2)}pp`
  );

  return lines.join("\n");
}
