import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPairedResumeSymmetry,
  pairedArmBatches,
  pairedArmOrder,
} from "./paired-scheduling";
import {
  ProviderCapture,
  type ProviderCaptureContext,
  type ProviderCaptureRecord,
} from "./provider-capture";
import {
  assertResumeFingerprint,
  benchmarkImplementationFingerprint,
  configurationFingerprint,
  sourceTreeFingerprint,
} from "./run-resume-integrity";

const temporaryDirectories: string[] = [];
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function captureContext(transport: "generate" | "stream") {
  return {
    arm: "glm5",
    attempt: 1,
    caseId: "case-1",
    jobKey: "case-1\u0000glm5\u00001",
    suite: "bfcl",
    tools: [
      {
        inputSchema: { properties: {}, type: "object" },
        name: "tool_name",
      },
    ],
    transport,
    trial: 1,
  } satisfies ProviderCaptureContext;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("provider capture", () => {
  it.each([
    ["generate", "application/json", '{"choices":[]}'],
    [
      "stream",
      "text/event-stream",
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
    ],
  ] as const)(
    "captures raw %s responses without transport credentials",
    async (transport, contentType, responseBody) => {
      const directory = mkdtempSync(join(tmpdir(), "glm5-capture-"));
      temporaryDirectories.push(directory);
      const output = join(directory, "provider-raw.jsonl");
      const fetchImpl: typeof fetch = async () =>
        new Response(responseBody, {
          headers: {
            "content-type": contentType,
            "set-cookie": "provider-session=must-not-be-recorded",
            "x-request-id": "request-1",
          },
          status: 200,
        });
      const capture = new ProviderCapture({
        arms: new Set(["glm5"]),
        enabled: true,
        fetchImpl,
        output,
      });
      capture.prepare(false);
      const ids: string[] = [];
      const response = await capture.run(captureContext(transport), ids, () =>
        capture.fetch(
          "https://user-secret:password-secret@provider.invalid/v1/chat/completions?api_key=query-secret&access_token=access-secret&client_secret=client-secret&x-api-key=alternate-secret&safe=1",
          {
            body: '{"model":"glm"}',
            headers: {
              authorization: "Bearer header-secret",
              "content-type": "application/json",
              "x-api-key": "second-header-secret",
            },
            method: "POST",
          }
        )
      );
      await response.text();
      await capture.flush();

      const raw = readFileSync(output, "utf8");
      expect(raw).not.toContain("query-secret");
      expect(raw).not.toContain("access-secret");
      expect(raw).not.toContain("alternate-secret");
      expect(raw).not.toContain("client-secret");
      expect(raw).not.toContain("header-secret");
      expect(raw).not.toContain("password-secret");
      expect(raw).not.toContain("provider-session");
      expect(raw).not.toContain("user-secret");
      const record = JSON.parse(raw) as ProviderCaptureRecord;
      expect(ids).toEqual([record.captureId]);
      expect(record.request.url).toContain("safe=1");
      expect(record.request.url).not.toContain("access_token");
      expect(record.request.url).not.toContain("client_secret");
      expect(record.request.url).not.toContain("x-api-key");
      expect(record.request.headers).toEqual({
        "content-type": "application/json",
      });
      expect(record.response?.body).toBe(responseBody);
      expect(record.response?.headers["x-request-id"]).toBe("request-1");
    }
  );

  it("redacts credential material from transport errors", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glm5-capture-error-"));
    temporaryDirectories.push(directory);
    const output = join(directory, "provider-raw.jsonl");
    const fetchImpl: typeof fetch = () =>
      Promise.reject(
        new Error(
          'request failed: https://provider.invalid/v1?access_token=query-secret Authorization: Bearer bearer-secret {"client_secret":"json-secret"} opaque-runtime-secret'
        )
      );
    const capture = new ProviderCapture({
      arms: new Set(["glm5"]),
      enabled: true,
      fetchImpl,
      output,
      secretValues: ["opaque-runtime-secret"],
    });
    capture.prepare(false);
    await expect(
      capture.run(captureContext("generate"), [], () =>
        capture.fetch("https://provider.invalid/v1", { method: "POST" })
      )
    ).rejects.toThrow("request failed");

    const raw = readFileSync(output, "utf8");
    expect(raw).not.toContain("query-secret");
    expect(raw).not.toContain("bearer-secret");
    expect(raw).not.toContain("json-secret");
    expect(raw).not.toContain("opaque-runtime-secret");
    const record = JSON.parse(raw) as ProviderCaptureRecord;
    expect(record.transportError).toContain("[REDACTED]");
  });

  it("redacts exact runtime credentials reflected in provider bodies", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glm5-capture-reflection-"));
    temporaryDirectories.push(directory);
    const output = join(directory, "provider-raw.jsonl");
    const capture = new ProviderCapture({
      arms: new Set(["glm5"]),
      enabled: true,
      fetchImpl: async () => new Response('{"echo":"opaque-runtime-secret"}'),
      output,
      secretValues: ["opaque-runtime-secret"],
    });
    capture.prepare(false);
    await capture.run(captureContext("generate"), [], () =>
      capture.fetch("https://provider.invalid/v1", {
        body: '{"echo":"opaque-runtime-secret"}',
        method: "POST",
      })
    );
    await capture.flush();
    const raw = readFileSync(output, "utf8");
    expect(raw).not.toContain("opaque-runtime-secret");
    expect(raw).toContain("[REDACTED]");
  });

  it("rejects capture IDs linked to a different benchmark job", () => {
    const directory = mkdtempSync(join(tmpdir(), "glm5-capture-linkage-"));
    temporaryDirectories.push(directory);
    const capture = join(directory, "provider-raw.jsonl");
    const result = join(directory, "raw.jsonl");
    writeFileSync(
      capture,
      `${JSON.stringify({
        captureId: "capture-1",
        context: {
          arm: "glm5",
          jobKey: "simple_python\u0000different-case\u0000glm5\u00001",
          suite: "bfcl",
          transport: "generate",
        },
        formatVersion: 1,
        request: {
          body: "{}",
          headers: { "content-type": "application/json" },
          method: "POST",
          url: "https://provider.invalid/v1",
        },
        response: {
          body: "{}",
          headers: { "content-type": "application/json" },
          status: 200,
          statusText: "OK",
        },
      })}\n`
    );
    writeFileSync(
      result,
      `${JSON.stringify({
        arm: "glm5",
        caseId: "case-1",
        category: "simple_python",
        rawCaptureIds: ["capture-1"],
        transport: "generate",
        transportOk: true,
        trial: 1,
      })}\n`
    );
    expect(() =>
      execFileSync(
        "python3",
        [
          "benchmarks/glm-5.2-tool-calling/validate_provider_capture.py",
          "--capture",
          capture,
          "--result-raw",
          result,
          "--expected-arms",
          "native,glm5",
        ],
        { cwd: process.cwd(), stdio: "pipe" }
      )
    ).toThrow();
  });

  it("refuses a linked resume when the prior capture artifact is missing", () => {
    const directory = mkdtempSync(join(tmpdir(), "glm5-capture-resume-"));
    temporaryDirectories.push(directory);
    const capture = new ProviderCapture({
      arms: new Set(["glm5"]),
      enabled: true,
      output: join(directory, "missing-provider-raw.jsonl"),
    });
    expect(() => capture.prepare(true, true)).toThrow(
      "prior provider capture is missing"
    );
  });
});

describe("paired scheduling", () => {
  it("keeps native and glm5 adjacent and alternates the leading arm", () => {
    const arms = [{ id: "native" }, { id: "glm5" }, { id: "other" }];
    const orders = Array.from({ length: 64 }, (_, index) =>
      pairedArmOrder(arms, 52, `case-${index}`).map((arm) => arm.id)
    );
    expect(orders.every((order) => order[2] === "other")).toBe(true);
    expect(orders.some((order) => order[0] === "native")).toBe(true);
    expect(orders.some((order) => order[0] === "glm5")).toBe(true);
  });

  it("places the native/glm5 pair in one sequential worker batch", () => {
    const arms = [{ id: "native" }, { id: "glm5" }, { id: "other" }];
    const batches = pairedArmBatches(arms, 52, "case-1").map((batch) =>
      batch.map((arm) => arm.id)
    );
    expect(batches).toHaveLength(2);
    expect(new Set(batches[0])).toEqual(new Set(["native", "glm5"]));
    expect(batches[1]).toEqual(["other"]);
  });

  it("rejects resume state containing only one completed arm of a pair", () => {
    expect(() =>
      assertPairedResumeSymmetry({
        completed: new Set(["case-1/native"]),
        pairs: [
          {
            glm5Key: "case-1/glm5",
            identity: "case-1",
            nativeKey: "case-1/native",
          },
        ],
      })
    ).toThrow("asymmetric native/glm5 completion");
    expect(() =>
      assertPairedResumeSymmetry({
        completed: new Set(["case-1/native", "case-1/glm5"]),
        pairs: [
          {
            glm5Key: "case-1/glm5",
            identity: "case-1",
            nativeKey: "case-1/native",
          },
        ],
      })
    ).not.toThrow();
  });
});

describe("resume integrity", () => {
  it("uses canonical fingerprints and refuses configuration drift", () => {
    const directory = mkdtempSync(join(tmpdir(), "glm5-resume-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, "raw.jsonl");
    const metaPath = join(directory, "run-meta.json");
    const expected = configurationFingerprint({
      arms: ["native", "glm5"],
      seed: 52,
    });
    expect(
      configurationFingerprint({ seed: 52, arms: ["native", "glm5"] })
    ).toBe(expected);

    assertResumeFingerprint({ expected, metaPath, outputPath, resume: true });
    writeFileSync(outputPath, "");
    writeFileSync(
      metaPath,
      `${JSON.stringify({ configFingerprint: expected })}\n`
    );
    assertResumeFingerprint({ expected, metaPath, outputPath, resume: true });
    expect(() =>
      assertResumeFingerprint({
        expected: configurationFingerprint({ arms: ["native"], seed: 52 }),
        metaPath,
        outputPath,
        resume: true,
      })
    ).toThrow("configuration fingerprint mismatch");
  });

  it("changes the source fingerprint when implementation bytes change", () => {
    const directory = mkdtempSync(join(tmpdir(), "glm5-source-fingerprint-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "runner.ts");
    writeFileSync(source, "export const revision = 1;\n");
    const before = sourceTreeFingerprint({ paths: [source], root: directory });
    writeFileSync(source, "export const revision = 2;\n");
    const after = sourceTreeFingerprint({ paths: [source], root: directory });
    expect(after).not.toBe(before);
  });

  it("fingerprints the benchmark, parser, and dependency implementation", () => {
    expect(benchmarkImplementationFingerprint()).toMatch(SHA256_PATTERN);
  });
});

describe("paired analysis denominators", () => {
  it("uses end-to-end strict outcomes for BFCL McNemar and preserves conditional semantics", () => {
    const directory = mkdtempSync(join(tmpdir(), "glm5-bfcl-analysis-"));
    temporaryDirectories.push(directory);
    const scored = join(directory, "scored.jsonl");
    const base = {
      attempts: 1,
      callShapeValid: true,
      calls: [],
      category: "simple_python",
      latencyMs: 1,
      parserErrors: [],
      protocolValid: true,
      scoreErrors: [],
      textLeak: false,
      trial: 1,
    };
    const rows = [
      {
        ...base,
        arm: "native",
        bfclCorrect: true,
        caseId: "loss",
        evaluable: true,
        strictCorrect: true,
      },
      {
        ...base,
        arm: "glm5",
        bfclCorrect: null,
        caseId: "loss",
        evaluable: false,
        strictCorrect: false,
      },
      {
        ...base,
        arm: "native",
        bfclCorrect: null,
        caseId: "recovery",
        evaluable: false,
        strictCorrect: false,
      },
      {
        ...base,
        arm: "glm5",
        bfclCorrect: true,
        caseId: "recovery",
        evaluable: true,
        strictCorrect: true,
      },
      {
        ...base,
        arm: "native",
        bfclCorrect: true,
        caseId: "semantic",
        evaluable: true,
        strictCorrect: true,
      },
      {
        ...base,
        arm: "glm5",
        bfclCorrect: false,
        caseId: "semantic",
        evaluable: true,
        strictCorrect: false,
      },
    ];
    writeFileSync(
      scored,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
    );
    execFileSync(
      process.execPath,
      ["benchmarks/glm-5.2-tool-calling/src/analyze.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BENCH_ANALYSIS_OUT: directory,
          BENCH_SCORED: scored,
        },
      }
    );
    const summary = JSON.parse(
      readFileSync(join(directory, "summary.json"), "utf8")
    );
    expect(summary.pairedVsNative[0]).toMatchObject({
      comparable: 3,
      conditionalSemanticComparable: 1,
      conditionalSemanticConversionLoss: 1,
      conditionalSemanticRecovery: 0,
      conversionLoss: 2,
      recovery: 1,
    });
    execFileSync(
      "python3",
      [
        "benchmarks/glm-5.2-tool-calling/render_svg_charts.py",
        "--chart-dir",
        join(directory, "charts"),
      ],
      { cwd: process.cwd() }
    );
    expect(
      readFileSync(join(directory, "charts", "accuracy.png")).length
    ).toBeGreaterThan(0);
  });

  it("includes registered and unregistered observed arms in BFCL analysis", () => {
    const directory = mkdtempSync(join(tmpdir(), "glm5-bfcl-arms-"));
    temporaryDirectories.push(directory);
    const scored = join(directory, "scored.jsonl");
    const arms = ["native", "glm5", "experimentalArm", "legacyText"];
    const rows = arms.map((arm) => ({
      arm,
      attempts: 1,
      bfclCorrect: true,
      callShapeValid: true,
      calls: [],
      caseId: "shared-case",
      category: "simple_python",
      evaluable: true,
      latencyMs: 1,
      parserErrors: [],
      protocolValid: true,
      scoreErrors: [],
      strictCorrect: true,
      textLeak: false,
      trial: 1,
    }));
    writeFileSync(
      scored,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
    );

    execFileSync(
      process.execPath,
      ["benchmarks/glm-5.2-tool-calling/src/analyze.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BENCH_ANALYSIS_OUT: directory,
          BENCH_SCORED: scored,
        },
      }
    );

    const summary = JSON.parse(
      readFileSync(join(directory, "summary.json"), "utf8")
    );
    expect(summary.arms.map((row: { arm: string }) => row.arm)).toEqual(arms);
    expect(
      summary.pairedVsNative.map((row: { arm: string }) => row.arm)
    ).toEqual(arms.slice(1));

    const accuracyChart = readFileSync(
      join(directory, "charts", "accuracy.svg"),
      "utf8"
    );
    expect(accuracyChart).toContain("experimentalArm");
    expect(accuracyChart).not.toContain('fill="undefined"');
  });

  it("uses oracle-valid end-to-end strict outcomes for ACE McNemar", () => {
    const directory = mkdtempSync(join(tmpdir(), "glm5-ace-analysis-"));
    temporaryDirectories.push(directory);
    const scored = join(directory, "scored.jsonl");
    const base = {
      benchmarkItemValid: true,
      callShapeValid: true,
      calls: [],
      category: "normal_single_turn_single_function",
      language: "en",
      latencyMs: 1,
      parserErrors: [],
      protocolValid: true,
      scoreErrors: [],
      textLeak: false,
      trial: 0,
    };
    const rows = [
      {
        ...base,
        aceCorrect: true,
        arm: "native",
        caseId: "loss",
        strictCorrect: true,
        transportOk: true,
      },
      {
        ...base,
        aceCorrect: null,
        arm: "glm5",
        caseId: "loss",
        strictCorrect: false,
        transportOk: false,
      },
      {
        ...base,
        aceCorrect: null,
        arm: "native",
        caseId: "recovery",
        strictCorrect: false,
        transportOk: false,
      },
      {
        ...base,
        aceCorrect: true,
        arm: "glm5",
        caseId: "recovery",
        strictCorrect: true,
        transportOk: true,
      },
      {
        ...base,
        aceCorrect: true,
        arm: "native",
        caseId: "semantic",
        strictCorrect: true,
        transportOk: true,
      },
      {
        ...base,
        aceCorrect: false,
        arm: "glm5",
        caseId: "semantic",
        strictCorrect: false,
        transportOk: true,
      },
    ];
    writeFileSync(
      scored,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
    );
    execFileSync(
      "python3",
      [
        "benchmarks/glm-5.2-tool-calling/analyze_ace.py",
        "--scored",
        scored,
        "--out-dir",
        directory,
      ],
      { cwd: process.cwd() }
    );
    const summary = JSON.parse(
      readFileSync(join(directory, "ace-summary.json"), "utf8")
    );
    expect(summary.pairedVsNative[0]).toMatchObject({
      comparable: 3,
      conditionalSemanticComparable: 1,
      conditionalSemanticConversionLoss: 1,
      conditionalSemanticRecovery: 0,
      conversionLoss: 2,
      recovery: 1,
    });
  });
});
