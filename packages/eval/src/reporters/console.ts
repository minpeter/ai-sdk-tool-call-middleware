import type { EvaluationResult } from "../interfaces";

// Basic ANSI color codes for console output
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
  white: "\x1b[37m",
  bgRed: "\x1b[41m",
};

function formatDiff(diff: string[]): string {
  if (!diff || diff.length === 0) {
    return "";
  }

  return diff
    .map((line) => {
      if (line.startsWith("-")) {
        return `${colors.red}${line}${colors.reset}`;
      }
      if (line.startsWith("+")) {
        return `${colors.green}${line}${colors.reset}`;
      }
      if (line.startsWith("@@")) {
        return `${colors.cyan}${line}${colors.reset}`;
      }
      return line;
    })
    .join("\n      ");
}

function printFailLogs(logs: string[]) {
  const failLogs = logs.filter((l) => l.startsWith("[DEBUG-FAIL]"));

  for (const log of failLogs) {
    try {
      const jsonStr = log.replace("[DEBUG-FAIL] ", "");
      const data = JSON.parse(jsonStr);

      console.log(`\n    ${colors.red}FAILED CASE: ${data.id}${colors.reset}`);
      console.log(
        `    Error Type: ${colors.yellow}${data.error_type || "unknown"}${colors.reset}`
      );
      console.log(`    Message: ${data.message}`);

      if (data.diff && Array.isArray(data.diff)) {
        console.log(`    Diff:\n      ${formatDiff(data.diff)}`);
      }

      // Expected vs Actual summary if diff is too complex or just to show quick view
      if (data.expected && data.actual) {
        // Simple one-line summary if possible
        const expStr = JSON.stringify(data.expected);
        const actStr = JSON.stringify(data.actual);
        if (expStr.length < 100 && actStr.length < 100) {
          console.log(`    Expected: ${colors.gray}${expStr}${colors.reset}`);
          console.log(`    Actual:   ${colors.gray}${actStr}${colors.reset}`);
        }
      }
    } catch (_e) {
      console.log(`    Raw Log: ${log}`);
    }
  }
}

function printResult(result: EvaluationResult) {
  const { model, modelKey, benchmark, result: benchmarkResult } = result;
  const status = benchmarkResult.success
    ? `${colors.green}✔ SUCCESS${colors.reset}`
    : `${colors.red}✖ FAILURE${colors.reset}`;

  console.log(
    `\n ${colors.cyan}[${model}]${colors.reset}${modelKey ? ` ${colors.gray}(${modelKey})${colors.reset}` : ""} - ${colors.magenta}${benchmark}${colors.reset}`
  );
  console.log(
    `  └ ${status} | Score: ${colors.yellow}${benchmarkResult.score.toFixed(2)}${colors.reset}`
  );

  const metrics = Object.entries(benchmarkResult.metrics);
  if (metrics.length > 0) {
    console.log("    Metrics:");
    for (const [key, value] of metrics) {
      console.log(`      - ${key}: ${value}`);
    }
  }

  if (benchmarkResult.error) {
    console.log(
      `    ${colors.red}Error: ${benchmarkResult.error.message}${colors.reset}`
    );
  }

  // Print failure details if any
  if (!benchmarkResult.success && benchmarkResult.logs) {
    printFailLogs(benchmarkResult.logs);

    // Fallback: if printFailLogs found nothing, dump raw logs
    const failLogs = benchmarkResult.logs.filter((l) =>
      l.startsWith("[DEBUG-FAIL]")
    );
    if (failLogs.length === 0 && benchmarkResult.logs.length > 0) {
      console.log("    Raw Logs (Sample):");
      for (const l of benchmarkResult.logs.slice(0, 10)) {
        console.log(`      ${l}`);
      }
    }
  }
}

export function consoleReporter(results: EvaluationResult[]): void {
  console.log("\n--- 📊 Evaluation Report ---");
  for (const result of results) {
    printResult(result);
  }
  console.log("\n---------------------------\n");
}
