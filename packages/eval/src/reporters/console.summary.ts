import type { EvaluationResult } from "../interfaces";

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
  white: "\x1b[37m",
};

const DEBUG_FAIL_REGEX = /^\[DEBUG-FAIL\] /;
const ID_NUM_REGEX = /_(\d+)$/;

interface FailureContext {
  raw_model_text?: string;
  raw_model_text_full?: string;
  parsed_tool_calls?: unknown[];
  expected_count?: number;
  actual_count?: number;
  finish_reason?: unknown;
  last_user_query?: string;
  tool_names?: string[];
}

interface ParsedFailure {
  id: string;
  category: string;
  message?: string;
  error_type?: string;
  expected?: Record<string, unknown>;
  actual?: Record<string, unknown>;
  diff?: string[];
  context?: FailureContext;
}

interface CategoryGroup {
  failures: ParsedFailure[];
  pattern?: string;
}

interface CategoryInfo {
  label: string;
  description: string;
  hint?: string;
}

const CATEGORY_DESCRIPTIONS: Record<string, CategoryInfo> = {
  PARSE_FAILURE: {
    label: "Parse Failure",
    description: "No tool calls extracted from model output",
    hint: "Model may have responded in text instead of tool format",
  },
  PARTIAL_CALLS: {
    label: "Partial Calls",
    description: "Some expected tool calls missing",
    hint: "Model stopped early or missed some tools",
  },
  EXTRA_CALLS: {
    label: "Extra Calls",
    description: "More tool calls than expected",
    hint: "Model called tools that weren't needed",
  },
  PARAM_VALUE_PERCENT: {
    label: "Param Value (Percent)",
    description: "Percentage sent as integer instead of decimal",
    hint: "e.g., 5 instead of 0.05 for 5%",
  },
  PARAM_VALUE_MISMATCH: {
    label: "Param Value Mismatch",
    description: "Parameter values don't match expected",
  },
  WRONG_FUNCTION: {
    label: "Wrong Function",
    description: "Called wrong function name",
  },
  MISSING_PARAMS: {
    label: "Missing Params",
    description: "Required parameters not provided",
  },
  UNEXPECTED_PARAMS: {
    label: "Unexpected Params",
    description: "Extra parameters that shouldn't be there",
  },
  NO_MATCH: {
    label: "No Match",
    description: "Function called but couldn't match to expected",
    hint: "Parameters may be correct but don't match any expected combination",
  },
  OTHER: {
    label: "Other",
    description: "Uncategorized failure",
  },
};

function parseFailureLogs(logs: string[]): ParsedFailure[] {
  const failures: ParsedFailure[] = [];

  for (const log of logs) {
    if (!DEBUG_FAIL_REGEX.test(log)) {
      continue;
    }

    try {
      const jsonStr = log.replace(DEBUG_FAIL_REGEX, "");
      const parsed = JSON.parse(jsonStr) as ParsedFailure;
      failures.push(parsed);
    } catch {}
  }

  return failures;
}

function groupByCategory(
  failures: ParsedFailure[]
): Map<string, CategoryGroup> {
  const groups = new Map<string, CategoryGroup>();

  for (const failure of failures) {
    const category = failure.category || "OTHER";
    const existing = groups.get(category);

    if (existing) {
      existing.failures.push(failure);
    } else {
      groups.set(category, { failures: [failure] });
    }
  }

  return groups;
}

function extractParamNames(failures: ParsedFailure[]): Set<string> {
  const paramNames = new Set<string>();
  for (const f of failures) {
    if (!f.diff) {
      continue;
    }
    for (const d of f.diff) {
      if (d.startsWith("@@ param ")) {
        paramNames.add(d.replace("@@ param ", ""));
      }
    }
  }
  return paramNames;
}

function extractFinishReasons(failures: ParsedFailure[]): Set<string> {
  const finishReasons = new Set<string>();
  for (const f of failures) {
    if (f.context?.finish_reason) {
      finishReasons.add(String(f.context.finish_reason));
    }
  }
  return finishReasons;
}

function detectPatterns(group: CategoryGroup): void {
  const { failures } = group;

  if (failures.length < 2) {
    return;
  }

  const firstCategory = failures[0].category;

  if (firstCategory === "PARAM_VALUE_PERCENT") {
    const paramNames = extractParamNames(failures);
    if (paramNames.size > 0) {
      group.pattern = `Affected params: ${[...paramNames].join(", ")}`;
    }
  }

  if (firstCategory === "PARSE_FAILURE") {
    const finishReasons = extractFinishReasons(failures);
    if (finishReasons.size === 1) {
      group.pattern = `All finished with: ${[...finishReasons][0]}`;
    }
  }
}

function formatTableRow(cells: string[], widths: number[]): string {
  return `│ ${cells.map((c, i) => c.padEnd(widths[i])).join(" │ ")} │`;
}

function formatTable(
  headers: string[],
  rows: string[][],
  columnWidths: number[]
): string[] {
  const lines: string[] = [];
  const totalWidth =
    columnWidths.reduce((a, b) => a + b, 0) + columnWidths.length * 3 + 1;

  lines.push(`┌${"─".repeat(totalWidth - 2)}┐`);
  lines.push(formatTableRow(headers, columnWidths));
  lines.push(`├${columnWidths.map((w) => "─".repeat(w + 2)).join("┼")}┤`);

  for (const row of rows) {
    lines.push(formatTableRow(row, columnWidths));
  }

  lines.push(`└${"─".repeat(totalWidth - 2)}┘`);
  return lines;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) {
    return str;
  }
  return `${str.slice(0, maxLen - 3)}...`;
}

function getLineColor(line: string): string {
  if (line.startsWith("+")) {
    return colors.green;
  }
  if (line.startsWith("-")) {
    return colors.red;
  }
  if (line.startsWith("@@")) {
    return colors.cyan;
  }
  return colors.white;
}

function formatFunctions(funcs: unknown): string {
  if (Array.isArray(funcs)) {
    return funcs.join(", ");
  }
  return String(funcs);
}

function printExpectedActual(failure: ParsedFailure): void {
  if (failure.expected) {
    const expFuncs = failure.expected.functions || failure.expected.function;
    if (expFuncs) {
      console.log(
        `    ${colors.gray}Expected:${colors.reset} ${formatFunctions(expFuncs)}`
      );
    }
  }

  if (failure.actual) {
    const actFuncs = failure.actual.functions || failure.actual.function;
    if (actFuncs) {
      const isEmpty = Array.isArray(actFuncs) && actFuncs.length === 0;
      const color = isEmpty ? colors.red : colors.white;
      const text = isEmpty ? "(none)" : formatFunctions(actFuncs);
      console.log(
        `    ${colors.gray}Actual:${colors.reset}   ${color}${text}${colors.reset}`
      );
    }
  }
}

function printDiff(diff: string[]): void {
  console.log(`    ${colors.gray}Diff:${colors.reset}`);
  for (const line of diff.slice(0, 5)) {
    const lineColor = getLineColor(line);
    console.log(`      ${lineColor}${line}${colors.reset}`);
  }
}

function printModelOutput(failure: ParsedFailure, category: string): void {
  if (failure.context?.raw_model_text && category === "PARSE_FAILURE") {
    const text = truncate(failure.context.raw_model_text, 100);
    console.log(
      `    ${colors.gray}Model said:${colors.reset} "${colors.dim}${text}${colors.reset}"`
    );
  }
}

function printSingleFailure(
  failure: ParsedFailure,
  category: string,
  verbose: boolean
): void {
  console.log(`\n  ${colors.bold}${failure.id}${colors.reset}`);
  printExpectedActual(failure);

  if (failure.diff && failure.diff.length > 0 && verbose) {
    printDiff(failure.diff);
  }

  printModelOutput(failure, category);
}

function printRemainingIds(failures: ParsedFailure[]): void {
  const remainingIds = failures.slice(2).map((f) => f.id);
  const idNums = remainingIds.map((id) => {
    const match = id.match(ID_NUM_REGEX);
    return match ? match[1] : id;
  });
  console.log(
    `\n  ${colors.dim}+${failures.length - 2} more: ${idNums.join(", ")}${colors.reset}`
  );
}

function printCategoryHeader(info: CategoryInfo, count: number): void {
  console.log(
    `\n${colors.cyan}───── ${info.label} (${count}) ─────${colors.reset}`
  );
  console.log(`${colors.dim}${info.description}${colors.reset}`);
}

function printCategoryDetails(
  category: string,
  group: CategoryGroup,
  verbose: boolean
): void {
  const info = CATEGORY_DESCRIPTIONS[category] || CATEGORY_DESCRIPTIONS.OTHER;
  const { failures } = group;

  printCategoryHeader(info, failures.length);

  if (group.pattern) {
    console.log(`${colors.yellow}Pattern: ${group.pattern}${colors.reset}`);
  }

  if (info.hint) {
    console.log(`${colors.magenta}Hint: ${info.hint}${colors.reset}`);
  }

  const samplesToShow = verbose ? failures : failures.slice(0, 2);

  for (const failure of samplesToShow) {
    printSingleFailure(failure, category, verbose);
  }

  if (!verbose && failures.length > 2) {
    printRemainingIds(failures);
  }
}

function printResultHeader(result: EvaluationResult): void {
  const { model, modelKey, benchmark, result: benchmarkResult } = result;

  const passed = benchmarkResult.metrics.correct_count as number | undefined;
  const total = benchmarkResult.metrics.total_cases as number | undefined;
  const scorePercent = (benchmarkResult.score * 100).toFixed(1);

  const statusIcon = benchmarkResult.success ? "✔" : "✖";
  const statusColor = benchmarkResult.success ? colors.green : colors.red;

  console.log(
    `\n${colors.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`
  );
  console.log(
    `${colors.cyan}${model}${colors.reset}${modelKey ? ` ${colors.dim}(${modelKey})${colors.reset}` : ""}`
  );
  console.log(`${colors.magenta}${benchmark}${colors.reset}`);
  console.log(
    `${statusColor}${statusIcon} ${scorePercent}%${colors.reset} (${passed ?? "?"}/${total ?? "?"} passed)`
  );
}

function printFailureTable(groups: Map<string, CategoryGroup>): void {
  console.log(`\n${colors.bold}FAILURE SUMMARY${colors.reset}`);

  const tableRows: string[][] = [];
  const sortedCategories = [...groups.entries()].sort(
    (a, b) => b[1].failures.length - a[1].failures.length
  );

  for (const [cat, group] of sortedCategories) {
    const info = CATEGORY_DESCRIPTIONS[cat] || CATEGORY_DESCRIPTIONS.OTHER;
    tableRows.push([info.label, String(group.failures.length)]);
  }

  const tableLines = formatTable(["Category", "Count"], tableRows, [22, 6]);

  for (const line of tableLines) {
    console.log(line);
  }
}

function printResultSummary(result: EvaluationResult, verbose: boolean): void {
  const { result: benchmarkResult } = result;

  printResultHeader(result);

  if (!benchmarkResult.logs || benchmarkResult.logs.length === 0) {
    return;
  }

  const failures = parseFailureLogs(benchmarkResult.logs);

  if (failures.length === 0) {
    if (!benchmarkResult.success) {
      console.log(
        `${colors.yellow}No structured failure data available${colors.reset}`
      );
    }
    return;
  }

  const groups = groupByCategory(failures);

  for (const group of groups.values()) {
    detectPatterns(group);
  }

  printFailureTable(groups);

  const sortedCategories = [...groups.entries()].sort(
    (a, b) => b[1].failures.length - a[1].failures.length
  );

  for (const [cat, group] of sortedCategories) {
    printCategoryDetails(cat, group, verbose);
  }
}

export function consoleSummaryReporter(results: EvaluationResult[]): void {
  const verbose = process.env.VERBOSE === "true";

  console.log(`\n${colors.bold}Evaluation Report (Summary)${colors.reset}`);
  console.log(`${colors.dim}Use VERBOSE=true for full details${colors.reset}`);

  for (const result of results) {
    printResultSummary(result, verbose);
  }

  console.log(
    `\n${colors.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`
  );
}
