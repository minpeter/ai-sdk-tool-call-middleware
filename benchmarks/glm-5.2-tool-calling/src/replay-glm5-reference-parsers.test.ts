import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CapturedFunctionTool,
  ProviderCaptureRecord,
} from "./provider-capture";
import {
  extractCapturedCanonicalContent,
  optionsFromArgv,
  runReferenceParserReplay,
} from "./replay-glm5-reference-parsers";

const TOOL: CapturedFunctionTool = {
  inputSchema: {
    additionalProperties: false,
    properties: { message: { type: "string" } },
    required: ["message"],
    type: "object",
  },
  name: "echo",
  originalName: "echo",
};
const CANONICAL =
  "<tool_call>echo<arg_key>message</arg_key><arg_value>hello</arg_value></tool_call>";

function capture(options: {
  body: string;
  captureId: string;
  caseId: string;
  suite: "ace" | "bfcl";
  transport: "generate" | "stream";
}): ProviderCaptureRecord {
  return {
    capturedAt: "2026-07-17T00:00:00.000Z",
    captureId: options.captureId,
    context: {
      arm: "glm5",
      attempt: 1,
      caseId: options.caseId,
      category:
        options.suite === "ace" ? "normal_atom_number" : "simple_python",
      jobKey: `${options.caseId}\0glm5`,
      language: options.suite === "ace" ? "en" : undefined,
      suite: options.suite,
      tools: [TOOL],
      transport: options.transport,
      trial: 1,
    },
    formatVersion: 1,
    request: {
      body: "{}",
      headers: {},
      method: "POST",
      url: "https://example.invalid/v1/chat/completions",
    },
    response: {
      body: options.body,
      headers: {
        "content-type":
          options.transport === "stream"
            ? "text/event-stream; charset=utf-8"
            : "application/json",
      },
      status: 200,
      statusText: "OK",
    },
  };
}

function sourceRow(options: {
  captureId: string;
  caseId: string;
  suite: "ace" | "bfcl";
  transport: "generate" | "stream";
}) {
  return {
    arm: "glm5",
    attempts: 1,
    calls: [{ arguments: { message: "hello" }, name: "echo" }],
    caseId: options.caseId,
    category: options.suite === "ace" ? "normal_atom_number" : "simple_python",
    language: options.suite === "ace" ? "en" : undefined,
    latencyMs: 1,
    model: "fixture",
    nameMap: [{ original: "echo", safe: "echo" }],
    parserErrors: [],
    rawCaptureIds: [options.captureId],
    text: "",
    textLeak: false,
    transport: options.transport,
    transportOk: true,
    trial: 1,
  };
}

describe("GLM reference replay CLI core", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const path of tempDirs.splice(0)) {
      rmSync(path, { force: true, recursive: true });
    }
  });

  it("extracts identical canonical content from JSON and captured SSE", () => {
    const jsonCapture = capture({
      body: JSON.stringify({
        choices: [{ message: { content: CANONICAL, role: "assistant" } }],
      }),
      captureId: "json",
      caseId: "json-case",
      suite: "bfcl",
      transport: "generate",
    });
    const sseCapture = capture({
      body: [
        `data: ${JSON.stringify({ choices: [{ delta: { content: CANONICAL.slice(0, 20) } }] })}`,
        "",
        `data: ${JSON.stringify({ choices: [{ delta: { content: CANONICAL.slice(20) } }] })}`,
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
      captureId: "sse",
      caseId: "sse-case",
      suite: "bfcl",
      transport: "stream",
    });
    expect(extractCapturedCanonicalContent(jsonCapture)).toMatchObject({
      errors: [],
      text: CANONICAL,
    });
    expect(extractCapturedCanonicalContent(sseCapture)).toMatchObject({
      chunks: [CANONICAL.slice(0, 20), CANONICAL.slice(20)],
      errors: [],
      text: CANONICAL,
    });
  });

  it("writes scorer-compatible natural rows plus separated synthetic artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "glm5-reference-replay-"));
    tempDirs.push(root);
    const outDir = join(root, "out");
    const jsonBody = JSON.stringify({
      choices: [{ message: { content: CANONICAL, role: "assistant" } }],
    });
    const sseBody = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: CANONICAL } }] })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const definitions = [
      {
        capture: capture({
          body: jsonBody,
          captureId: "bfcl-capture",
          caseId: "bfcl-case",
          suite: "bfcl",
          transport: "generate",
        }),
        name: "bfcl",
        row: sourceRow({
          captureId: "bfcl-capture",
          caseId: "bfcl-case",
          suite: "bfcl",
          transport: "generate",
        }),
      },
      {
        capture: capture({
          body: jsonBody,
          captureId: "ace-capture",
          caseId: "ace-case",
          suite: "ace",
          transport: "generate",
        }),
        name: "ace",
        row: sourceRow({
          captureId: "ace-capture",
          caseId: "ace-case",
          suite: "ace",
          transport: "generate",
        }),
      },
      {
        capture: capture({
          body: sseBody,
          captureId: "sse-capture",
          caseId: "sse-case",
          suite: "bfcl",
          transport: "stream",
        }),
        name: "sse",
        row: sourceRow({
          captureId: "sse-capture",
          caseId: "sse-case",
          suite: "bfcl",
          transport: "stream",
        }),
      },
    ];
    for (const definition of definitions) {
      writeFileSync(
        join(root, `${definition.name}-capture.jsonl`),
        `${JSON.stringify(definition.capture)}\n`
      );
      writeFileSync(
        join(root, `${definition.name}-raw.jsonl`),
        `${JSON.stringify(definition.row)}\n`
      );
    }

    const summary = await runReferenceParserReplay({
      aceCapture: join(root, "ace-capture.jsonl"),
      aceRaw: join(root, "ace-raw.jsonl"),
      bfclCapture: join(root, "bfcl-capture.jsonl"),
      bfclRaw: join(root, "bfcl-raw.jsonl"),
      generatedAt: "2026-07-17T08:08:47.112Z",
      outDir,
      python: "python3",
      score: false,
      sseCapture: join(root, "sse-capture.jsonl"),
      sseRaw: join(root, "sse-raw.jsonl"),
    });
    expect(summary.generatedAt).toBe("2026-07-17T08:08:47.112Z");
    expect(summary.naturalTotal).toBe(3);
    expect(summary.naturalProductionChunkInvariant).toBe(3);
    expect(summary.providerCalls).toBe(0);
    const bfclRows = readFileSync(
      join(outDir, "natural-bfcl-generate.raw.jsonl"),
      "utf8"
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(bfclRows).toHaveLength(5);
    expect(bfclRows.map((row) => row.arm).sort()).toEqual([
      "productionGenerate",
      "productionStream",
      "sglangReference",
      "vllmPythonReference",
      "vllmReference",
    ]);
    expect(bfclRows.every((row) => row.transportOk === true)).toBe(true);
    expect(
      readFileSync(join(outDir, "synthetic-corpus.jsonl"), "utf8")
    ).toContain("synthetic-official-template-derived");
  });

  it("parses CLI overrides without requiring credentials", () => {
    const options = optionsFromArgv([
      "--out-dir",
      "/tmp/reference-out",
      "--skip-score",
      "--python",
      "python-custom",
      "--generated-at",
      "2026-07-17T17:08:47.112+09:00",
    ]);
    expect(options.outDir).toBe("/tmp/reference-out");
    expect(options.generatedAt).toBe("2026-07-17T08:08:47.112Z");
    expect(options.score).toBe(false);
    expect(options.python).toBe("python-custom");
  });

  it("rejects a non-ISO deterministic artifact timestamp", () => {
    expect(() =>
      optionsFromArgv(["--generated-at", "2026-07-17 08:08:47"])
    ).toThrow("--generated-at must be a valid ISO-8601 timestamp");
  });
});
