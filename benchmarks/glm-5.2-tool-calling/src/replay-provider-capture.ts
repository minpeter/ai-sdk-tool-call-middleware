import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ProviderCaptureRecord } from "./provider-capture";
import {
  type ReplayParserChoice,
  replayProviderCaptureResponse,
} from "./replay-provider-capture-core";

interface CliOptions {
  arms: ReadonlySet<string>;
  input: string;
  output: string;
  parser: ReplayParserChoice;
  suite?: string;
}

interface ReplayResult {
  arm: string;
  attempt: number;
  attempts: number;
  calls: Array<{ arguments: unknown; name: string; safeName: string }>;
  captureId: string;
  caseId?: string;
  category?: string;
  chunkInvariant?: true;
  chunkSnapshotSha256?: string;
  jobKey: string;
  language?: string;
  latencyMs: number;
  model: "parser-only-replay";
  nameMap: Array<{ original: string; safe: string }>;
  parser: "glm5" | "native";
  parserErrors: string[];
  rawBodySha256: string;
  rawTextSha256: string;
  responseChunks: number;
  sseByteChunkVariants: number;
  streamDeltaChunkVariants: number;
  suite: string;
  taskId?: string;
  text: string;
  textLeak: boolean;
  transport: "generate" | "stream";
  transportOk: boolean;
  trial: number;
  turn?: number;
}

const HELP = `Usage:
  pnpm dlx tsx benchmarks/glm-5.2-tool-calling/src/replay-provider-capture.ts \\
    --input <provider-raw.jsonl> --out <replayed.jsonl> [options]

Options:
  --arms native,glm5        Capture arms to replay (default: both)
  --parser auto|native|glm5
                            Response semantics to use (default: auto by arm)
  --suite bfcl|ace|mcpmark Optional suite filter
  --help                    Show this help

Auto semantics:
  native      provider-native calls without middleware repair
  glm5        canonical GLM-5.2 prompt-only text middleware
`;

function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    }
    if (!token?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${token} requires a value`);
    }
    values.set(token, value);
    index += 1;
  }
  const input = values.get("--input");
  const output = values.get("--out");
  if (!(input && output)) {
    throw new Error(`--input and --out are required\n\n${HELP}`);
  }
  const parser = values.get("--parser") ?? "auto";
  if (!(parser === "auto" || parser === "glm5" || parser === "native")) {
    throw new Error("--parser must be auto, native, or glm5");
  }
  return {
    arms: new Set(
      (values.get("--arms") ?? "native,glm5")
        .split(",")
        .map((arm) => arm.trim())
        .filter(Boolean)
    ),
    input: resolve(input),
    output: resolve(output),
    parser,
    suite: values.get("--suite"),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function loadJsonl(path: string): ProviderCaptureRecord[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      const value = JSON.parse(line) as ProviderCaptureRecord;
      if (!(value.captureId && value.context && value.request)) {
        throw new Error(`Invalid capture row ${index + 1}`);
      }
      return value;
    });
}

function hasMarkupLeak(text: string): boolean {
  return ["<tool_call", "</tool_call", "<arg_key>", "<arg_value>"].some(
    (marker) => text.includes(marker)
  );
}

async function replay(
  record: ProviderCaptureRecord,
  parserChoice: ReplayParserChoice
): Promise<ReplayResult> {
  const parserErrors: string[] = [];
  const parsed = await replayProviderCaptureResponse(
    record,
    parserChoice,
    parserErrors
  );
  return {
    arm: record.context.arm,
    attempt: record.context.attempt,
    attempts: record.context.attempt,
    calls: parsed.calls,
    caseId: record.context.caseId,
    category: record.context.category,
    captureId: record.captureId,
    chunkInvariant: parsed.chunkInvariance.checked ? true : undefined,
    chunkSnapshotSha256: parsed.chunkInvariance.normalizedSnapshotSha256,
    jobKey: record.context.jobKey,
    language: record.context.language,
    latencyMs: 0,
    model: "parser-only-replay",
    nameMap: record.context.tools.map((tool) => ({
      original: tool.originalName ?? tool.name,
      safe: tool.name,
    })),
    parser: parsed.parser,
    parserErrors,
    rawBodySha256: sha256(record.response?.body ?? ""),
    rawTextSha256: sha256(parsed.rawText),
    responseChunks: parsed.responseChunks,
    sseByteChunkVariants: parsed.chunkInvariance.sseByteChunkVariants,
    streamDeltaChunkVariants: parsed.chunkInvariance.streamDeltaChunkVariants,
    suite: record.context.suite,
    taskId: record.context.taskId,
    text: parsed.text,
    textLeak: hasMarkupLeak(parsed.text),
    transport: record.context.transport,
    transportOk:
      !record.transportError &&
      record.response !== undefined &&
      record.response.status >= 200 &&
      record.response.status < 300,
    trial: record.context.trial,
    turn: record.context.turn,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const captures = loadJsonl(options.input).filter(
    (record) =>
      options.arms.has(record.context.arm) &&
      (!options.suite || record.context.suite === options.suite)
  );
  const results = await Promise.all(
    captures.map((record) => replay(record, options.parser))
  );
  results.sort((left, right) => {
    const jobDelta = left.jobKey.localeCompare(right.jobKey);
    if (jobDelta !== 0) {
      return jobDelta;
    }
    const attemptDelta = left.attempt - right.attempt;
    return attemptDelta === 0
      ? (left.turn ?? 0) - (right.turn ?? 0)
      : attemptDelta;
  });
  mkdirSync(dirname(options.output), { recursive: true });
  writeFileSync(
    options.output,
    results.length > 0
      ? `${results.map((result) => JSON.stringify(result)).join("\n")}\n`
      : ""
  );
  console.log(
    `Replayed ${results.length} provider captures -> ${options.output}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
