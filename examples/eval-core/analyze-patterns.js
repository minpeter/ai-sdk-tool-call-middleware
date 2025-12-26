const fs = require("node:fs");

const log = fs.readFileSync("bfcl-debug-30.log", "utf8");
const cases = log.split("========== BFCL CASE DEBUG ==========").slice(1);

console.log(`Total cases: ${cases.length}\n`);

const patterns = {
  duplicates: [],
  toolNameMismatch: [],
  parsingFailure: [],
  parameterIssues: [],
};

for (const caseLog of cases) {
  const _lines = caseLog.split("\n");
  const testCaseMatch = caseLog.match(/Test Case: (\S+)/);
  const expectedCountMatch = caseLog.match(/Expected count: (\d+) call/);
  const parsedCountMatch = caseLog.match(/PARSED TOOL CALLS \(count: (\d+)\)/);

  if (!(testCaseMatch && expectedCountMatch && parsedCountMatch)) {
    continue;
  }

  const testCase = testCaseMatch[1];
  const expected = Number.parseInt(expectedCountMatch[1], 10);
  const parsed = Number.parseInt(parsedCountMatch[1], 10);

  // Duplicate detection
  if (expected === 1 && parsed > 1) {
    patterns.duplicates.push({
      testCase,
      expected,
      parsed,
      ratio: parsed / expected,
    });
  }

  // Parsing failure
  if (expected > 0 && parsed === 0) {
    patterns.parsingFailure.push({
      testCase,
      expected,
    });
  }

  // Count mismatch (not exact duplicates)
  if (expected > 0 && parsed !== expected && parsed !== 0) {
    const ratio = parsed / expected;
    if (Math.abs(ratio - Math.round(ratio)) < 0.1) {
      patterns.duplicates.push({
        testCase,
        expected,
        parsed,
        ratio,
      });
    }
  }
}

console.log("=== DUPLICATE GENERATION PATTERN ===");
console.log(`Cases with duplicates: ${patterns.duplicates.length}`);
if (patterns.duplicates.length > 0) {
  const ratios = patterns.duplicates.map((p) => p.ratio);
  const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  console.log(`Average duplication ratio: ${avgRatio.toFixed(2)}x`);
  console.log("\nExamples:");
  for (const p of patterns.duplicates.slice(0, 10)) {
    console.log(
      `  ${p.testCase}: expected ${p.expected}, got ${p.parsed} (${p.ratio.toFixed(1)}x)`
    );
  }
}

console.log("\n=== PARSING FAILURE PATTERN ===");
console.log(
  `Cases with 0 parsed (expected > 0): ${patterns.parsingFailure.length}`
);
if (patterns.parsingFailure.length > 0) {
  console.log("\nExamples:");
  for (const p of patterns.parsingFailure.slice(0, 10)) {
    console.log(`  ${p.testCase}: expected ${p.expected}, got 0`);
  }
}
