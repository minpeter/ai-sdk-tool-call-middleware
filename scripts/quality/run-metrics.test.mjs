import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./run-metrics.mjs", import.meta.url));
const HALSTEAD_VIOLATION =
  /fixture\.ts: halstead\.difficulty=\d+(?:\.\d+)? \(required < 80\)/;
const CLEAN_SOURCE = `export function double(value: number): number {
  return value * 2;
}\n`;
const VIOLATING_SOURCE = `export function difficult(value: number): number {
  return ${Array.from({ length: 100 }, () => "value").join(" + ")};
}\n`;

function runFixture(source) {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), "quality-metrics-"));
  writeFileSync(join(fixtureDirectory, "fixture.ts"), source);
  try {
    return spawnSync(
      process.execPath,
      [runner, "--source-dir", fixtureDirectory],
      { encoding: "utf8" }
    );
  } finally {
    rmSync(fixtureDirectory, { force: true, recursive: true });
  }
}

test("emits the pass sentinel when every file is below every threshold", () => {
  // Given: a directory containing one low-complexity TypeScript file.
  const fixture = CLEAN_SOURCE;

  // When: the metrics quality gate analyzes the directory.
  const result = runFixture(fixture);

  // Then: the gate succeeds with its sentinel as the final output line.
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.trimEnd().split("\n").at(-1),
    "QUALITY_THRESHOLDS_PASS"
  );
});

test("emits the fail sentinel and metric value when a threshold is reached", () => {
  // Given: a TypeScript file whose Halstead difficulty exceeds the limit.
  const fixture = VIOLATING_SOURCE;

  // When: the metrics quality gate analyzes the directory.
  const result = runFixture(fixture);

  // Then: the gate fails, identifies the file and reports the offending value.
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, HALSTEAD_VIOLATION);
  assert.equal(
    result.stdout.trimEnd().split("\n").at(-1),
    "QUALITY_THRESHOLDS_FAIL"
  );
});
