import { EvaluationResult } from "@/interfaces";

// Basic ANSI color codes for console output
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
};

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
}

export function consoleReporter(results: EvaluationResult[]): void {
  console.log("\n--- 📊 Evaluation Report ---");
  for (const result of results) {
    printResult(result);
  }
  console.log("\n---------------------------\n");
}
