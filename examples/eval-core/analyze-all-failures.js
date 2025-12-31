#!/usr/bin/env node

const fs = require("node:fs");

// Regex patterns at top level for performance
const SCORE_REGEX = /Score: ([\d.]+)/;
const CORRECT_COUNT_REGEX = /correct_count: (\d+)/;
const TOTAL_CASES_REGEX = /total_cases: (\d+)/;

console.log("=".repeat(80));
console.log("COMPREHENSIVE FAILURE ANALYSIS");
console.log("=".repeat(80));
console.log();

// Parse BFCL results
function parseBFCLLog(logFile) {
  if (!fs.existsSync(logFile)) {
    return { notReady: true };
  }

  const content = fs.readFileSync(logFile, "utf-8");

  // Extract scores
  const scores = {};
  const scoreMatches = content.matchAll(
    /\[(.+?)\] \(glm-4\.6\) Finished benchmark: (bfcl-.+?)\. Score: ([\d.]+)/g
  );
  for (const match of scoreMatches) {
    const [, _model, benchmark, score] = match;
    scores[benchmark] = Number.parseFloat(score);
  }

  // Check if complete
  const isComplete = content.includes("Full BFCL evaluation complete");

  return { scores, isComplete, totalTests: Object.keys(scores).length };
}

// Parse ComplexFuncBench results
function parseComplexFuncBenchLog(logFile) {
  if (!fs.existsSync(logFile)) {
    return { notReady: true };
  }

  const content = fs.readFileSync(logFile, "utf-8");

  // Extract score and metrics
  const scoreMatch = content.match(SCORE_REGEX);
  const correctMatch = content.match(CORRECT_COUNT_REGEX);
  const totalMatch = content.match(TOTAL_CASES_REGEX);
  const isComplete = content.includes("ComplexFuncBench evaluation complete");

  if (!scoreMatch) {
    return { notReady: true };
  }

  return {
    score: Number.parseFloat(scoreMatch[1]),
    correct: Number.parseInt(correctMatch?.[1] || "0", 10),
    total: Number.parseInt(totalMatch?.[1] || "0", 10),
    isComplete,
  };
}

// Analyze BFCL
console.log("📊 BFCL RESULTS\n");
const bfclResults = parseBFCLLog("bfcl-glm-full.log");

if (bfclResults.notReady) {
  console.log("  ⏳ Test not yet started or no results available\n");
} else {
  console.log(
    `  Status: ${bfclResults.isComplete ? "✅ Complete" : "⏳ Running..."}`
  );
  console.log(`  Benchmarks tested: ${bfclResults.totalTests}/4\n`);

  for (const [benchmark, score] of Object.entries(bfclResults.scores)) {
    let status;
    if (score >= 0.9) {
      status = "✅";
    } else if (score >= 0.7) {
      status = "⚠️";
    } else {
      status = "❌";
    }
    const percentage = (score * 100).toFixed(1);
    console.log(`  ${status} ${benchmark.padEnd(30)} ${percentage}%`);
  }

  // Calculate average
  const scores = Object.values(bfclResults.scores);
  if (scores.length > 0) {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    console.log(`\n  Average Score: ${(avg * 100).toFixed(1)}%`);
  }
}

console.log(`\n${"=".repeat(80)}`);

// Analyze ComplexFuncBench
console.log("\n🔥 COMPLEXFUNCBENCH RESULTS\n");
const cfbResults = parseComplexFuncBenchLog("complex-func-bench-glm-full.log");

if (cfbResults.notReady) {
  console.log("  ⏳ Test not yet started or no results available\n");
} else {
  console.log(
    `  Status: ${cfbResults.isComplete ? "✅ Complete" : "⏳ Running..."}`
  );
  console.log(`  Score: ${(cfbResults.score * 100).toFixed(1)}%`);
  console.log(`  Correct: ${cfbResults.correct}/${cfbResults.total}`);
  console.log(`  Failed: ${cfbResults.total - cfbResults.correct}\n`);

  let status;
  if (cfbResults.score >= 0.9) {
    status = "✅ Excellent";
  } else if (cfbResults.score >= 0.8) {
    status = "✅ Good";
  } else if (cfbResults.score >= 0.7) {
    status = "⚠️ Acceptable";
  } else {
    status = "❌ Needs Improvement";
  }
  console.log(`  Overall: ${status}`);
}

console.log(`\n${"=".repeat(80)}`);

// Summary
console.log("\n📈 SUMMARY\n");

if (bfclResults.notReady || cfbResults.notReady) {
  console.log("  ⏳ Waiting for tests to start...");
} else {
  const bfclComplete = bfclResults.isComplete;
  const cfbComplete = cfbResults.isComplete;

  if (bfclComplete && cfbComplete) {
    console.log("  ✅ All tests completed successfully!\n");

    const bfclScores = Object.values(bfclResults.scores);
    const bfclAvg = bfclScores.reduce((a, b) => a + b, 0) / bfclScores.length;

    console.log(`  BFCL Average: ${(bfclAvg * 100).toFixed(1)}%`);
    console.log(`  ComplexFuncBench: ${(cfbResults.score * 100).toFixed(1)}%`);
    console.log(
      `  Overall Performance: ${(((bfclAvg + cfbResults.score) / 2) * 100).toFixed(1)}%`
    );

    // Calculate total failures
    const bfclTotalCases =
      bfclScores.length > 0
        ? Math.round(
            bfclScores.reduce((sum, score, _i) => {
              // Estimate ~100 cases per benchmark
              return sum + Math.round((1 - score) * 100);
            }, 0)
          )
        : 0;

    const totalFailures =
      bfclTotalCases + (cfbResults.total - cfbResults.correct);

    console.log(`\n  📊 Total Failures to Analyze: ~${totalFailures}`);
    console.log(`     - BFCL: ~${bfclTotalCases} cases`);
    console.log(
      `     - ComplexFuncBench: ${cfbResults.total - cfbResults.correct} cases`
    );
  } else {
    console.log("  ⏳ Tests still running...");
    if (!bfclComplete) {
      console.log("     - BFCL: in progress");
    }
    if (!cfbComplete) {
      console.log("     - ComplexFuncBench: in progress");
    }
  }
}

console.log(`\n${"=".repeat(80)}`);
console.log();
