#!/usr/bin/env node

const fs = require("node:fs");

const logFile = "qwen-glm-full-debug.log";
const content = fs.readFileSync(logFile, "utf-8");

// Extract all test case debug sections
const sections = content.split("========== BFCL CASE DEBUG ==========");

const failures = {
  qwen: { simple: [], multiple: [], parallel: [], parallel_multiple: [] },
  glm: { simple: [], multiple: [], parallel: [], parallel_multiple: [] },
};

let currentModel = null;
let currentBenchmark = null;

for (let i = 1; i < sections.length; i++) {
  const section = sections[i];

  // Extract test case ID
  const testCaseMatch = section.match(/Test Case: (\w+_\d+)/);
  if (!testCaseMatch) {
    continue;
  }
  const testCase = testCaseMatch[1];

  // Determine benchmark type
  if (testCase.startsWith("simple_")) {
    currentBenchmark = "simple";
  } else if (testCase.startsWith("parallel_multiple_")) {
    currentBenchmark = "parallel_multiple";
  } else if (testCase.startsWith("parallel_")) {
    currentBenchmark = "parallel";
  } else if (testCase.startsWith("multiple_")) {
    currentBenchmark = "multiple";
  }

  // Extract model (look for qwen or glm in previous section or model name patterns)
  // Check if the output contains GLM-specific patterns like <think> tags
  const hasThinkTag = section.includes("<think>");
  currentModel = hasThinkTag ? "glm" : "qwen";

  // Extract expected count
  const expectedCountMatch = section.match(/Expected count: (\d+) call/);
  if (!expectedCountMatch) {
    continue;
  }
  const expectedCount = Number.parseInt(expectedCountMatch[1], 10);

  // Extract parsed tool calls count
  const parsedCountMatch = section.match(
    /--- PARSED TOOL CALLS \(count: (\d+)\)/
  );
  if (!parsedCountMatch) {
    continue;
  }
  const parsedCount = Number.parseInt(parsedCountMatch[1], 10);

  // Extract expected output
  const expectedMatch = section.match(
    /--- EXPECTED OUTPUT \(morphXML format\) ---\n([\s\S]*?)\n\n--- ACTUAL MODEL OUTPUT/
  );
  const expectedOutput = expectedMatch ? expectedMatch[1].trim() : "";

  // Extract actual output
  const actualMatch = section.match(
    /--- ACTUAL MODEL OUTPUT \(raw, with whitespace\) ---\n([\s\S]*?)\n\n--- PARSED TOOL CALLS/
  );
  const actualOutput = actualMatch ? actualMatch[1].trim() : "";

  // Extract parsed tool calls
  const parsedMatch = section.match(
    /--- PARSED TOOL CALLS \(count: \d+\) ---\n([\s\S]*?)\n======================================/
  );
  const parsedCalls = parsedMatch ? parsedMatch[1].trim() : "";

  // Only record failures
  if (expectedCount !== parsedCount || parsedCount === 0) {
    failures[currentModel][currentBenchmark].push({
      testCase,
      expectedCount,
      parsedCount,
      expectedOutput,
      actualOutput,
      parsedCalls,
    });
  }
}

// Print summary
console.log("=".repeat(80));
console.log("FAILURE ANALYSIS: Qwen3-30B-A3B vs GLM-4.6");
console.log("=".repeat(80));
console.log();

for (const model of ["qwen", "glm"]) {
  const modelName = model === "qwen" ? "Qwen3-30B-A3B" : "GLM-4.6";
  console.log(`\n${"=".repeat(80)}`);
  console.log(`${modelName.toUpperCase()} FAILURES`);
  console.log(`${"=".repeat(80)}\n`);

  for (const benchmark of [
    "simple",
    "multiple",
    "parallel",
    "parallel_multiple",
  ]) {
    const cases = failures[model][benchmark];
    if (cases.length === 0) {
      console.log(`✅ ${benchmark.toUpperCase()}: No failures`);
      continue;
    }

    console.log(`\n❌ ${benchmark.toUpperCase()}: ${cases.length} failures`);
    console.log("-".repeat(80));

    for (const failure of cases) {
      console.log(`\n[${failure.testCase}]`);
      console.log(`  Expected: ${failure.expectedCount} call(s)`);
      console.log(`  Parsed: ${failure.parsedCount} call(s)`);

      // Analyze failure type
      if (failure.parsedCount === 0) {
        console.log("  ⚠️  PARSING FAILURE: No tool calls extracted");
        console.log(
          `\n  Expected Output:\n${failure.expectedOutput
            .split("\n")
            .map((l) => `    ${l}`)
            .join("\n")}`
        );
        console.log(
          `\n  Actual Output:\n${failure.actualOutput
            .split("\n")
            .slice(0, 10)
            .map((l) => `    ${l}`)
            .join("\n")}`
        );
        if (failure.actualOutput.split("\n").length > 10) {
          console.log(
            `    ... (${failure.actualOutput.split("\n").length - 10} more lines)`
          );
        }
      } else if (failure.parsedCount < failure.expectedCount) {
        console.log(
          `  ⚠️  INCOMPLETE: Missing ${failure.expectedCount - failure.parsedCount} call(s)`
        );
      } else {
        console.log(
          `  ⚠️  OVER-GENERATED: ${failure.parsedCount - failure.expectedCount} extra call(s)`
        );
      }
    }
  }
}

// Print statistics
console.log(`\n\n${"=".repeat(80)}`);
console.log("STATISTICS");
console.log(`${"=".repeat(80)}\n`);

for (const model of ["qwen", "glm"]) {
  const modelName = model === "qwen" ? "Qwen3-30B-A3B" : "GLM-4.6";
  console.log(`${modelName}:`);

  let totalFailures = 0;
  let parsingFailures = 0;
  let incompleteFailures = 0;

  for (const benchmark of [
    "simple",
    "multiple",
    "parallel",
    "parallel_multiple",
  ]) {
    const cases = failures[model][benchmark];
    totalFailures += cases.length;

    for (const failure of cases) {
      if (failure.parsedCount === 0) {
        parsingFailures++;
      } else if (failure.parsedCount < failure.expectedCount) {
        incompleteFailures++;
      }
    }
  }

  console.log(`  Total Failures: ${totalFailures}`);
  console.log(`  Parsing Failures (0 calls): ${parsingFailures}`);
  console.log(`  Incomplete (missing calls): ${incompleteFailures}`);
  console.log(`  Simple: ${failures[model].simple.length}`);
  console.log(`  Multiple: ${failures[model].multiple.length}`);
  console.log(`  Parallel: ${failures[model].parallel.length}`);
  console.log(
    `  Parallel-Multiple: ${failures[model].parallel_multiple.length}`
  );
  console.log();
}

// Identify common patterns
console.log(`\n${"=".repeat(80)}`);
console.log("COMMON FAILURE PATTERNS");
console.log(`${"=".repeat(80)}\n`);

// Pattern 1: Parsing failures (0 calls)
console.log("1. COMPLETE PARSING FAILURES (0 tool calls extracted):\n");
for (const model of ["qwen", "glm"]) {
  const modelName = model === "qwen" ? "Qwen3-30B-A3B" : "GLM-4.6";
  const parsingFailures = [];

  for (const benchmark of [
    "simple",
    "multiple",
    "parallel",
    "parallel_multiple",
  ]) {
    parsingFailures.push(
      ...failures[model][benchmark].filter((f) => f.parsedCount === 0)
    );
  }

  if (parsingFailures.length > 0) {
    console.log(`  ${modelName}: ${parsingFailures.length} cases`);
    for (const failure of parsingFailures.slice(0, 3)) {
      console.log(
        `    - ${failure.testCase}: Expected ${failure.expectedCount}, got 0`
      );
    }
    if (parsingFailures.length > 3) {
      console.log(`    ... and ${parsingFailures.length - 3} more`);
    }
  }
}

// Pattern 2: Incomplete (missing some calls)
console.log("\n2. INCOMPLETE GENERATION (missing some tool calls):\n");
for (const model of ["qwen", "glm"]) {
  const modelName = model === "qwen" ? "Qwen3-30B-A3B" : "GLM-4.6";
  const incompleteFailures = [];

  for (const benchmark of [
    "simple",
    "multiple",
    "parallel",
    "parallel_multiple",
  ]) {
    incompleteFailures.push(
      ...failures[model][benchmark].filter(
        (f) => f.parsedCount > 0 && f.parsedCount < f.expectedCount
      )
    );
  }

  if (incompleteFailures.length > 0) {
    console.log(`  ${modelName}: ${incompleteFailures.length} cases`);
    for (const failure of incompleteFailures.slice(0, 3)) {
      console.log(
        `    - ${failure.testCase}: Expected ${failure.expectedCount}, got ${failure.parsedCount}`
      );
    }
    if (incompleteFailures.length > 3) {
      console.log(`    ... and ${incompleteFailures.length - 3} more`);
    }
  }
}

console.log();
