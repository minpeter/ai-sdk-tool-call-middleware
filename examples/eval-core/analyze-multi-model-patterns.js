const fs = require("node:fs");

const log = fs.readFileSync("bfcl-test-models-10.log", "utf8");

// Split by model
const models = ["MiniMax-M2", "GLM-4.6", "Qwen3-30B-A3B"];
const modelStats = {};

for (const modelName of models) {
  let modelId;
  if (modelName.includes("GLM")) {
    modelId = "zai-org/GLM-4.6";
  } else if (modelName.includes("Qwen")) {
    modelId = "Qwen/Qwen3-30B-A3B";
  } else {
    modelId = "MiniMaxAI/MiniMax-M2";
  }

  // Find all BFCL CASE DEBUG sections for this model
  const modelPattern = new RegExp(
    `\\[${modelId.replace(/\//g, "\\/")}\\].*?Running benchmark[\\s\\S]*?(?=\\[(?:${models
      .map((m) => {
        if (m.includes("GLM")) {
          return "zai-org/GLM-4.6";
        }
        if (m.includes("Qwen")) {
          return "Qwen/Qwen3-30B-A3B";
        }
        return "MiniMaxAI/MiniMax-M2";
      })
      .join("|")
      .replace(/\//g, "\\/")})|$)`,
    "g"
  );

  const modelSection = log.match(modelPattern)?.[0] || "";
  const cases = modelSection
    .split("========== BFCL CASE DEBUG ==========")
    .slice(1);

  console.log(`\n=== ${modelName} ===`);
  console.log(`Total cases found: ${cases.length}`);

  const stats = {
    duplicates: [],
    parsingFailures: [],
    correct: [],
  };

  for (const caseLog of cases) {
    const testCaseMatch = caseLog.match(/Test Case: (\S+)/);
    const expectedMatch = caseLog.match(/Expected count: (\d+) call/);
    const parsedMatch = caseLog.match(/PARSED TOOL CALLS \(count: (\d+)\)/);

    if (!(testCaseMatch && expectedMatch && parsedMatch)) {
      continue;
    }

    const testCase = testCaseMatch[1];
    const expected = Number.parseInt(expectedMatch[1], 10);
    const parsed = Number.parseInt(parsedMatch[1], 10);

    if (expected === parsed && expected > 0) {
      stats.correct.push({ testCase, count: expected });
    } else if (expected > 0 && parsed > expected) {
      stats.duplicates.push({
        testCase,
        expected,
        parsed,
        ratio: parsed / expected,
      });
    } else if (expected > 0 && parsed === 0) {
      stats.parsingFailures.push({ testCase, expected });
    }
  }

  console.log(`  Correct: ${stats.correct.length}`);
  console.log(`  Duplicates: ${stats.duplicates.length}`);
  if (stats.duplicates.length > 0) {
    const avgRatio =
      stats.duplicates.reduce((sum, d) => sum + d.ratio, 0) /
      stats.duplicates.length;
    console.log(`    Average duplication ratio: ${avgRatio.toFixed(2)}x`);
    console.log("    Examples:");
    for (const d of stats.duplicates.slice(0, 3)) {
      console.log(
        `      ${d.testCase}: expected ${d.expected}, got ${d.parsed} (${d.ratio.toFixed(1)}x)`
      );
    }
  }
  console.log(`  Parsing failures: ${stats.parsingFailures.length}`);
  if (stats.parsingFailures.length > 0) {
    console.log("    Examples:");
    for (const p of stats.parsingFailures.slice(0, 3)) {
      console.log(`      ${p.testCase}: expected ${p.expected}, got 0`);
    }
  }

  modelStats[modelName] = stats;
}

// Summary comparison
console.log("\n=== SUMMARY ===");
console.log("Model Performance Comparison:");
for (const modelName of models) {
  const stats = modelStats[modelName];
  const total =
    stats.correct.length +
    stats.duplicates.length +
    stats.parsingFailures.length;
  console.log(`\n${modelName}:`);
  console.log(
    `  Success rate: ${((stats.correct.length / total) * 100).toFixed(1)}%`
  );
  console.log(
    `  Duplicate rate: ${((stats.duplicates.length / total) * 100).toFixed(1)}%`
  );
  console.log(
    `  Failure rate: ${((stats.parsingFailures.length / total) * 100).toFixed(1)}%`
  );
}
