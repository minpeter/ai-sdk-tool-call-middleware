import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProviderCaptureRecord } from "./provider-capture";
import { replayProviderCaptureResponse } from "./replay-provider-capture-core";

interface RequestRow {
  model?: string;
  parserErrors?: string[];
  requestId?: string;
  upstreamCaptureIds?: string[];
}

interface AuditDetail {
  calls: number;
  replayFailures: number;
  replayRecoveries: number;
  requestId: string;
  status: "missing-capture" | "no-call" | "recovered" | "still-failed";
}

const FAILURE = /^Could not parse(?: streaming)? GLM-5\.2 tool call\./u;
const RECOVERY = /^Recovered malformed GLM-5\.2 tool call\./u;

function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function jsonl<T>(path: string): T[] {
  const lines = readFileSync(path, "utf8").split("\n");
  const rows: T[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      continue;
    }
    try {
      rows.push(JSON.parse(line) as T);
    } catch (error) {
      if (index === lines.length - 1) {
        continue;
      }
      throw error;
    }
  }
  return rows;
}

function countByStatus(details: AuditDetail[]): Record<string, number> {
  return Object.fromEntries(
    [...new Set(details.map((detail) => detail.status))]
      .sort()
      .map((status) => [
        status,
        details.filter((detail) => detail.status === status).length,
      ])
  );
}

export async function auditLiveGlm5ParserFailures(options: {
  capturePath: string;
  model: string;
  requestPath: string;
}): Promise<{ details: AuditDetail[]; sourceFailureRequests: number }> {
  const requests = jsonl<RequestRow>(options.requestPath).filter(
    (row) =>
      row.model === options.model &&
      row.parserErrors?.some((error) => FAILURE.test(error))
  );
  const captures = new Map(
    jsonl<ProviderCaptureRecord>(options.capturePath).map((capture) => [
      capture.captureId,
      capture,
    ])
  );
  const details: AuditDetail[] = [];
  for (const request of requests) {
    const requestId = request.requestId ?? "unknown";
    const capture = [...(request.upstreamCaptureIds ?? [])]
      .reverse()
      .map((captureId) => captures.get(captureId))
      .find((candidate) => candidate !== undefined);
    if (!capture) {
      details.push({
        calls: 0,
        replayFailures: 0,
        replayRecoveries: 0,
        requestId,
        status: "missing-capture",
      });
      continue;
    }
    const errors: string[] = [];
    const replay = await replayProviderCaptureResponse(capture, "glm5", errors);
    const replayFailures = errors.filter((error) => FAILURE.test(error)).length;
    const replayRecoveries = errors.filter((error) =>
      RECOVERY.test(error)
    ).length;
    let status: AuditDetail["status"] = "no-call";
    if (replayFailures > 0) {
      status = "still-failed";
    } else if (replay.calls.length > 0) {
      status = "recovered";
    }
    details.push({
      calls: replay.calls.length,
      replayFailures,
      replayRecoveries,
      requestId,
      status,
    });
  }
  return { details, sourceFailureRequests: requests.length };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const capturePath = argument(args, "--capture");
  const requestPath = argument(args, "--requests");
  if (!(capturePath && requestPath)) {
    throw new Error("--capture and --requests are required");
  }
  const result = await auditLiveGlm5ParserFailures({
    capturePath: resolve(capturePath),
    model: argument(args, "--model") ?? "glm52-prompt-only",
    requestPath: resolve(requestPath),
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        counts: countByStatus(result.details),
        ...(args.includes("--details") ? { details: result.details } : {}),
        sourceFailureRequests: result.sourceFailureRequests,
      },
      null,
      2
    )}\n`
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
