import type { EvaluationResult } from "../interfaces";

// Regex patterns at module level for performance
const FAIL_ID_REGEX = /^\[FAIL\]\s+([^:]+):/;
const DEBUG_FAIL_PREFIX_REGEX = /^\[DEBUG-FAIL\] /;
const DEBUG_FAIL_CONTEXT_PREFIX_REGEX = /^\[DEBUG-FAIL-CONTEXT\] /;

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
  underline: "\x1b[4m",
};

function colorizeDiffLine(line: string): string {
  if (line.startsWith("+")) {
    return `${colors.green}${line}${colors.reset}`;
  }
  if (line.startsWith("-")) {
    return `${colors.red}${line}${colors.reset}`;
  }
  if (line.startsWith("@")) {
    return `${colors.cyan}${colors.bold}${line}${colors.reset}`;
  }
  return line;
}

function uniqueLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    if (seen.has(l)) {
      continue;
    }
    seen.add(l);
    out.push(l);
  }
  return out;
}

// Helper function to check if diff contains function name issues
function hasFunctionNameIssue(diff: unknown[]): boolean {
  return diff.some(
    (d: unknown) =>
      String(d).includes("function name") ||
      String(d).includes("missing function:")
  );
}

// Helper function to suggest function name fixes
function suggestFunctionNameFix(
  expected: unknown,
  actual: unknown,
  suggestions: string[]
): void {
  const expectedName = (expected as Record<string, unknown> | undefined)
    ?.function as string | undefined;
  const actualName = (actual as Record<string, unknown> | undefined)
    ?.function as string | undefined;
  if (expectedName && actualName && expectedName !== actualName) {
    suggestions.push(
      `Call the function '${expectedName}' instead of '${actualName}'.`
    );
  }
  if (Array.isArray((expected as Record<string, unknown>)?.functions)) {
    suggestions.push(
      `Ensure tool calls include: ${((expected as Record<string, unknown>).functions as string[]).join(", ")}.`
    );
  }
}

// Helper function to suggest missing parameter fixes
function suggestMissingParamFix(diff: unknown[], suggestions: string[]): void {
  const missing = diff
    .filter((d: unknown) => String(d).startsWith("- missing required param:"))
    .map((d: unknown) => String(d).replace("- missing required param: ", ""));
  if (missing.length) {
    suggestions.push(`Add required parameter(s): ${missing.join(", ")}.`);
  }
}

// Helper function to suggest unexpected parameter fixes
function suggestUnexpectedParamFix(
  diff: unknown[],
  suggestions: string[]
): void {
  const extras = diff
    .filter((d: unknown) => String(d).startsWith("+ unexpected param:"))
    .map((d: unknown) => String(d).replace("+ unexpected param: ", ""));
  if (extras.length) {
    suggestions.push(`Remove unexpected parameter(s): ${extras.join(", ")}.`);
  }
}

// Helper function to suggest parameter value fixes
function suggestParamValueFix(diff: unknown[], suggestions: string[]): void {
  const targets = diff
    .filter((d: unknown) => String(d).startsWith("@@ param "))
    .map((d: unknown) => String(d).replace("@@ param ", ""));
  for (const param of targets) {
    const allowedOneOfLine = (diff as unknown[]).find((d: unknown) =>
      String(d).startsWith("- expected one of:")
    ) as string | undefined;
    const allowedSingleLine = (diff as unknown[]).find((d: unknown) =>
      String(d).startsWith("- expected:")
    ) as string | undefined;
    if (allowedSingleLine) {
      const value = allowedSingleLine.replace("- expected: ", "");
      suggestions.push(`Set '${param}' to: ${value}.`);
    } else if (allowedOneOfLine) {
      const allowed = allowedOneOfLine.replace("- expected one of: ", "");
      suggestions.push(`Set '${param}' to one of: ${allowed}.`);
    } else {
      suggestions.push(`Adjust '${param}' to an allowed value.`);
    }
  }
}

// Helper function to suggest fixes based on error type
function suggestFromErrorType(error_type: string, suggestions: string[]): void {
  if (error_type.includes("missing_required")) {
    suggestions.push("Add all required parameters defined by the tool schema.");
  } else if (error_type.includes("unexpected_param")) {
    suggestions.push("Remove parameters not present in the tool schema.");
  } else if (error_type.includes("wrong_count")) {
    suggestions.push(
      "Adjust the number of tool calls to match expected count."
    );
  } else if (error_type.includes("wrong_func_name")) {
    suggestions.push("Use the exact expected function name from the schema.");
  } else if (error_type.includes("value_error")) {
    suggestions.push("Choose a value from the allowed options.");
  }
}

function suggestFixFromDiff(parsed: unknown): string[] {
  const suggestions: string[] = [];
  const { error_type, expected, actual, diff } =
    (parsed as Record<string, unknown>) ?? {};

  if (!Array.isArray(diff)) {
    if (suggestions.length === 0 && typeof error_type === "string") {
      suggestFromErrorType(error_type, suggestions);
    }
    return uniqueLines(suggestions);
  }

  if (hasFunctionNameIssue(diff)) {
    suggestFunctionNameFix(expected, actual, suggestions);
  }

  if (
    diff.some((d: unknown) => String(d).startsWith("- missing required param:"))
  ) {
    suggestMissingParamFix(diff, suggestions);
  }

  if (diff.some((d: unknown) => String(d).startsWith("+ unexpected param:"))) {
    suggestUnexpectedParamFix(diff, suggestions);
  }

  if (diff.some((d: unknown) => String(d).startsWith("@@ param "))) {
    suggestParamValueFix(diff, suggestions);
  }

  if (suggestions.length === 0 && typeof error_type === "string") {
    suggestFromErrorType(error_type, suggestions);
  }

  return uniqueLines(suggestions);
}

// Helper function to extract test ID from a log line
function getTestIdFromLogLine(line: string): string | undefined {
  if (line.startsWith("[FAIL]")) {
    const m = line.match(FAIL_ID_REGEX);
    return m?.[1];
  }
  if (line.startsWith("[DEBUG-FAIL]")) {
    try {
      const parsed = JSON.parse(line.replace(DEBUG_FAIL_PREFIX_REGEX, ""));
      return String(parsed?.id ?? "");
    } catch {
      // Intentionally ignore: malformed [DEBUG-FAIL] payloads are expected when
      // earlier steps fail to JSON-stringify complex values (circular/BigInt/etc.).
      // We only use parsed IDs for de-duplication, so a parse miss is safe.
    }
  }
  if (line.startsWith("[DEBUG-FAIL-CONTEXT]")) {
    try {
      const parsed = JSON.parse(
        line.replace(DEBUG_FAIL_CONTEXT_PREFIX_REGEX, "")
      );
      return String(parsed?.id ?? "");
    } catch {
      /* intentionally ignored */
    }
  }
  return;
}

// Helper function to group logs by test ID
function groupLogsByTestId(failLogs: string[]): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const line of failLogs) {
    const id = getTestIdFromLogLine(line);
    const key = id ?? "__general__";
    const arr = byId.get(key) ?? [];
    arr.push(line);
    byId.set(key, arr);
  }
  return byId;
}

// Helper function to collect debug IDs from lines
function collectDebugIds(lines: string[]): Set<string> {
  const debugIds = new Set<string>();
  for (const l of lines) {
    if (l.startsWith("[DEBUG-FAIL]")) {
      try {
        const parsed = JSON.parse(l.replace(DEBUG_FAIL_PREFIX_REGEX, ""));
        if (parsed?.id) {
          debugIds.add(String(parsed.id));
        }
      } catch {
        /* intentionally ignored */
      }
    }
  }
  return debugIds;
}

// Helper function to print formatted JSON with indentation
function printIndentedJson(prefix: string, data: unknown, color: string): void {
  console.log(
    color +
      prefix +
      JSON.stringify(data, null, 2).split("\n").join("\n            ") +
      colors.reset
  );
}

// Helper function to handle DEBUG-FAIL line display
function displayDebugFailLine(line: string): void {
  const payload = line.replace(DEBUG_FAIL_PREFIX_REGEX, "");
  try {
    const parsed = JSON.parse(payload);
    const { message, diff, expected, actual } = parsed;
    if (message) {
      console.log(`        ${colors.bold}${message}${colors.reset}`);
    }
    if (diff && Array.isArray(diff)) {
      for (const dLine of diff) {
        console.log(`          ${colorizeDiffLine(dLine)}`);
      }
    } else {
      console.log("          expected:");
      printIndentedJson("            ", expected, colors.green);
      console.log("          actual:");
      printIndentedJson("            ", actual, colors.red);
    }
    const suggestions = suggestFixFromDiff(parsed);
    if (suggestions.length) {
      console.log(`          ${colors.bold}Suggested fix:${colors.reset}`);
      for (const s of suggestions) {
        console.log(`            • ${s}`);
      }
    }
  } catch {
    console.log(`        ${line}`);
  }
}

// Helper function to display context information
function displayContextInfo(ctx: Record<string, unknown>): void {
  if (ctx.tool_schema) {
    printIndentedJson("          tool schema: ", ctx.tool_schema, colors.gray);
  }
  if (ctx.last_user_query) {
    console.log(
      colors.gray +
        "          last user: " +
        JSON.stringify(ctx.last_user_query) +
        colors.reset
    );
  }
  if (ctx.raw_model_text) {
    console.log(
      colors.gray +
        "          raw model text (middleware parsed):\n            " +
        String(ctx.raw_model_text).split("\n").join("\n            ") +
        colors.reset
    );
  }
  if (ctx.parsed_tool_calls) {
    printIndentedJson(
      "          parsed tool calls: ",
      ctx.parsed_tool_calls,
      colors.gray
    );
  }
  if (ctx.ground_truth) {
    printIndentedJson(
      "          ground truth: ",
      ctx.ground_truth,
      colors.gray
    );
  }
  if (ctx.finish_reason) {
    console.log(
      colors.gray +
        "          finish reason: " +
        JSON.stringify(ctx.finish_reason) +
        colors.reset
    );
  }
}

// Helper function to handle DEBUG-FAIL-CONTEXT line display
function displayDebugFailContextLine(line: string): void {
  const payload = line.replace(DEBUG_FAIL_CONTEXT_PREFIX_REGEX, "");
  try {
    const ctx = JSON.parse(payload) as Record<string, unknown>;
    console.log(`        ${colors.gray}context:${colors.reset}`);
    displayContextInfo(ctx);
  } catch {
    console.log(`        ${line}`);
  }
}

// Helper function to display a single log line
function displayLogLine(line: string, debugIds: Set<string>): void {
  if (line.startsWith("[FAIL]")) {
    const m = line.match(FAIL_ID_REGEX);
    const failId = m?.[1];
    if (failId && debugIds.has(failId)) {
      return;
    }
    console.log(`        ${colors.red}${line}${colors.reset}`);
  } else if (line.startsWith("[ERROR]") || line.startsWith("[FATAL]")) {
    console.log(`        ${colors.yellow}${line}${colors.reset}`);
  } else if (line.startsWith("[STACK]")) {
    console.log(`        ${colors.gray}${line}${colors.reset}`);
  } else if (line.startsWith("[DEBUG-FAIL]")) {
    displayDebugFailLine(line);
  } else if (line.startsWith("[DEBUG-FAIL-CONTEXT]")) {
    displayDebugFailContextLine(line);
  }
}

// Helper function to display grouped failure logs
function displayGroupedFailures(byId: Map<string, string[]>): void {
  console.log(`    ${colors.bold}Failure details (grouped):${colors.reset}`);
  for (const [groupId, lines] of byId) {
    if (groupId !== "__general__") {
      console.log(`      ${colors.underline}${groupId}${colors.reset}`);
    }
    const debugIds = collectDebugIds(lines);
    for (const line of lines) {
      displayLogLine(line, debugIds);
    }
  }
}

// Helper function to display success logs
function displaySuccessLogs(logs: string[]): void {
  const info = logs.filter(
    (l) => l.startsWith("[INFO]") || l.startsWith("[PASS]")
  );
  for (const line of info) {
    console.log(`      ${colors.gray}${line}${colors.reset}`);
  }
}

// Helper function to filter failure-related logs
function filterFailureLogs(logs: string[]): string[] {
  return logs.filter(
    (l) =>
      l.startsWith("[FAIL]") ||
      l.startsWith("[ERROR]") ||
      l.startsWith("[FATAL]") ||
      l.startsWith("[STACK]") ||
      l.startsWith("[DEBUG-FAIL]") ||
      l.startsWith("[DEBUG-FAIL-CONTEXT]")
  );
}

// Helper function to display logs for a result
function displayResultLogs(logs: string[]): void {
  const failLogs = filterFailureLogs(logs);
  const hasFails = failLogs.length > 0;
  if (hasFails) {
    const byId = groupLogsByTestId(failLogs);
    displayGroupedFailures(byId);
  } else {
    displaySuccessLogs(logs);
  }
}

// Helper function to display metrics
function displayMetrics(metrics: [string, unknown][]): void {
  if (metrics.length > 0) {
    console.log("    Metrics:");
    for (const [k, v] of metrics) {
      console.log(`      - ${k}: ${v}`);
    }
  }
}

// Helper function to display result header
function displayResultHeader(r: EvaluationResult): void {
  const { model, modelKey, benchmark, result } = r;
  const status = result.success
    ? `${colors.green}✔ SUCCESS${colors.reset}`
    : `${colors.red}✖ FAILURE${colors.reset}`;

  console.log(
    `\n ${colors.cyan}[${model}]${colors.reset}${modelKey ? ` ${colors.gray}(${modelKey})${colors.reset}` : ""} - ${colors.magenta}${benchmark}${colors.reset}`
  );
  console.log(
    `  └ ${status} | Score: ${colors.yellow}${result.score.toFixed(2)}${colors.reset}`
  );
}

export function consoleDebugReporter(results: EvaluationResult[]): void {
  console.log("\n--- 📊 Evaluation Report (debug) ---");
  for (const r of results) {
    displayResultHeader(r);
    displayMetrics(Object.entries(r.result.metrics));
    if (r.result.logs?.length) {
      displayResultLogs(r.result.logs);
    }
  }
  console.log("\n------------------------------------\n");
}
