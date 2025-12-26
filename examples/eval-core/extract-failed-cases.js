#!/usr/bin/env node

const fs = require("node:fs");

console.log("=".repeat(80));
console.log("EXTRACTING FAILED BFCL CASES");
console.log("=".repeat(80));
console.log();

const logFile = "bfcl-glm-full.log";

if (!fs.existsSync(logFile)) {
  console.log("❌ Log file not found:", logFile);
  process.exit(1);
}

const content = fs.readFileSync(logFile, "utf-8");

// Extract failed cases
const failedCases = {};
const failureRegex = /FAILED CASE: (\w+_\d+)/g;

const matches = Array.from(content.matchAll(failureRegex));
for (const match of matches) {
  const caseId = match[1];

  // Determine benchmark type
  let benchmarkType;
  if (caseId.startsWith("simple_")) {
    benchmarkType = "simple";
  } else if (caseId.startsWith("parallel_multiple_")) {
    benchmarkType = "parallel-multiple";
  } else if (caseId.startsWith("parallel_")) {
    benchmarkType = "parallel";
  } else if (caseId.startsWith("multiple_")) {
    benchmarkType = "multiple";
  } else {
    benchmarkType = "unknown";
  }

  if (!failedCases[benchmarkType]) {
    failedCases[benchmarkType] = [];
  }
  failedCases[benchmarkType].push(caseId);
}

// Print summary
console.log("📊 FAILURE SUMMARY BY BENCHMARK:\n");

let totalFailures = 0;
for (const [benchmark, cases] of Object.entries(failedCases)) {
  console.log(`  ${benchmark.toUpperCase()}:`);
  console.log(`    Total failures: ${cases.length}`);
  console.log(`    First 5: ${cases.slice(0, 5).join(", ")}`);
  console.log();
  totalFailures += cases.length;
}

console.log(`  TOTAL FAILURES: ${totalFailures}`);
console.log();

// Extract scores
const scores = {};
const scoreMatches = content.matchAll(
  /Finished benchmark: (bfcl-.+?)\. Score: ([\d.]+)/g
);
for (const match of scoreMatches) {
  const [, benchmark, score] = match;
  scores[benchmark] = Number.parseFloat(score);
}

console.log("=".repeat(80));
console.log();
console.log("📈 SCORE BREAKDOWN:\n");

for (const [benchmark, score] of Object.entries(scores)) {
  const percentage = (score * 100).toFixed(1);
  let status;
  if (score >= 0.9) {
    status = "✅";
  } else if (score >= 0.8) {
    status = "⚠️";
  } else {
    status = "❌";
  }
  console.log(`  ${status} ${benchmark.padEnd(30)} ${percentage}%`);
}

// Calculate average
const scoreValues = Object.values(scores);
if (scoreValues.length > 0) {
  const avg = scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length;
  console.log(`\n  Average: ${(avg * 100).toFixed(1)}%`);
}

console.log();
console.log("=".repeat(80));
console.log();

// Save failed cases to file
const outputFile = "bfcl-failed-cases.json";
fs.writeFileSync(outputFile, JSON.stringify(failedCases, null, 2));
console.log(`✅ Failed cases saved to: ${outputFile}`);
console.log();

// Sample failure details
console.log("=".repeat(80));
console.log();
console.log("📋 SAMPLE FAILURE DETAILS:\n");

// Extract first few failure details
const sampleFailures = content.split("FAILED CASE:").slice(1, 4);

for (const failure of sampleFailures) {
  const lines = failure.split("\n").slice(0, 8);
  console.log(`FAILED CASE:${lines.join("\n")}`);
  console.log();
}

console.log("=".repeat(80));
console.log();
