import type { EvaluationResult } from "../interfaces";

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
  white: "\x1b[37m",
};

const DEBUG_FAIL_REGEX = /^\[DEBUG-FAIL\] /;

interface ParsedFailure {
  id: string;
  category?: string;
  message?: string;
  error_type?: string;
  expected?: Record<string, unknown>;
  actual?: Record<string, unknown>;
  diff?: string[];
  context?: {
    raw_model_text?: string;
    expected_count?: number;
    actual_count?: number;
  };
}

function formatDiff(diff: string[]): string {
  if (!diff || diff.length === 0) {
    return "";
  }

  return diff
    .slice(0, 8)
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

function parseFailures(logs: string[]): ParsedFailure[] {
  const failures: ParsedFailure[] = [];

  for (const log of logs) {
    if (!DEBUG_FAIL_REGEX.test(log)) {
      continue;
    }

    try {
      const jsonStr = log.replace(DEBUG_FAIL_REGEX, "");
      const parsed = JSON.parse(jsonStr) as ParsedFailure;
      failures.push(parsed);
    } catch {
      // Malformed JSON, skip
    }
  }

  return failures;
}

function groupFailuresByCategory(
  failures: ParsedFailure[]
): Map<string, ParsedFailure[]> {
  const groups = new Map<string, ParsedFailure[]>();

  for (const failure of failures) {
    const category = failure.category || "OTHER";
    const existing = groups.get(category);

    if (existing) {
      existing.push(failure);
    } else {
      groups.set(category, [failure]);
    }
  }

  return groups;
}

function printCompactFailure(failure: ParsedFailure): void {
  console.log(
    `\n    ${colors.red}${failure.id}${colors.reset} [${colors.yellow}${failure.category || "OTHER"}${colors.reset}]`
  );

  if (failure.message) {
    console.log(`      ${failure.message}`);
  }

  if (failure.diff && failure.diff.length > 0) {
    console.log(`      ${formatDiff(failure.diff)}`);
  }

  if (failure.context?.raw_model_text && failure.category === "PARSE_FAILURE") {
    const text = failure.context.raw_model_text;
    const truncated = text.length > 80 ? `${text.slice(0, 80)}...` : text;
    console.log(`      ${colors.gray}Model: "${truncated}"${colors.reset}`);
  }
}

function printFailureSummary(failures: ParsedFailure[]): void {
  const groups = groupFailuresByCategory(failures);
  const sorted = [...groups.entries()].sort(
    (a, b) => b[1].length - a[1].length
  );

  console.log(`\n    ${colors.bold}Failures by category:${colors.reset}`);

  for (const [category, categoryFailures] of sorted) {
    console.log(
      `      ${colors.yellow}${category}${colors.reset}: ${categoryFailures.length}`
    );
  }

  const maxToShow = 5;
  const shown = failures.slice(0, maxToShow);

  for (const failure of shown) {
    printCompactFailure(failure);
  }

  if (failures.length > maxToShow) {
    const remaining = failures.length - maxToShow;
    const remainingIds = failures.slice(maxToShow).map((f) => f.id);
    const idPreview = remainingIds.slice(0, 5).join(", ");
    const more = remainingIds.length > 5 ? "..." : "";
    console.log(
      `\n    ${colors.gray}+${remaining} more: ${idPreview}${more}${colors.reset}`
    );
  }
}

function printResult(result: EvaluationResult): void {
  const { model, modelKey, benchmark, result: benchmarkResult } = result;

  const passed = benchmarkResult.metrics.correct_count as number | undefined;
  const total = benchmarkResult.metrics.total_cases as number | undefined;
  const scorePercent = (benchmarkResult.score * 100).toFixed(1);

  const statusIcon = benchmarkResult.success ? "✔" : "✖";
  const statusColor = benchmarkResult.success ? colors.green : colors.red;

  console.log(
    `\n ${colors.cyan}[${model}]${colors.reset}${modelKey ? ` ${colors.gray}(${modelKey})${colors.reset}` : ""} - ${colors.magenta}${benchmark}${colors.reset}`
  );
  console.log(
    `  └ ${statusColor}${statusIcon} ${scorePercent}%${colors.reset} (${passed ?? "?"}/${total ?? "?"} passed)`
  );

  if (benchmarkResult.error) {
    console.log(
      `    ${colors.red}Error: ${benchmarkResult.error.message}${colors.reset}`
    );
  }

  if (!benchmarkResult.success && benchmarkResult.logs) {
    const failures = parseFailures(benchmarkResult.logs);

    if (failures.length > 0) {
      printFailureSummary(failures);
    } else if (benchmarkResult.logs.length > 0) {
      console.log(`    ${colors.gray}Raw Logs (Sample):${colors.reset}`);
      for (const l of benchmarkResult.logs.slice(0, 5)) {
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
