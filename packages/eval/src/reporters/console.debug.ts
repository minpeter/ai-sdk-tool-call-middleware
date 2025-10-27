import type { EvaluationResult } from "@/interfaces";

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
  if (line.startsWith("+")) return `${colors.green}${line}${colors.reset}`;
  if (line.startsWith("-")) return `${colors.red}${line}${colors.reset}`;
  if (line.startsWith("@"))
    return `${colors.cyan}${colors.bold}${line}${colors.reset}`;
  return line;
}

function uniqueLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    if (seen.has(l)) continue;
    seen.add(l);
    out.push(l);
  }
  return out;
}

function suggestFixFromDiff(parsed: unknown): string[] {
  const suggestions: string[] = [];
  const { error_type, expected, actual, diff } =
    (parsed as Record<string, unknown>) ?? {};

  if (
    (Array.isArray(diff) &&
      diff.some((d: unknown) => String(d).includes("function name"))) ||
    (Array.isArray(diff) &&
      diff.some((d: unknown) => String(d).includes("missing function:")))
  ) {
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

  if (
    Array.isArray(diff) &&
    diff.some((d: unknown) => String(d).startsWith("- missing required param:"))
  ) {
    const missing = diff
      .filter((d: unknown) => String(d).startsWith("- missing required param:"))
      .map((d: unknown) => String(d).replace("- missing required param: ", ""));
    if (missing.length) {
      suggestions.push(`Add required parameter(s): ${missing.join(", ")}.`);
    }
  }

  if (
    Array.isArray(diff) &&
    diff.some((d: unknown) => String(d).startsWith("+ unexpected param:"))
  ) {
    const extras = diff
      .filter((d: unknown) => String(d).startsWith("+ unexpected param:"))
      .map((d: unknown) => String(d).replace("+ unexpected param: ", ""));
    if (extras.length) {
      suggestions.push(`Remove unexpected parameter(s): ${extras.join(", ")}.`);
    }
  }

  if (
    Array.isArray(diff) &&
    diff.some((d: unknown) => String(d).startsWith("@@ param "))
  ) {
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

  if (suggestions.length === 0 && typeof error_type === "string") {
    if (error_type.includes("missing_required")) {
      suggestions.push(
        "Add all required parameters defined by the tool schema."
      );
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

  return uniqueLines(suggestions);
}

export function consoleDebugReporter(results: EvaluationResult[]): void {
  console.log("\n--- 📊 Evaluation Report (debug) ---");
  for (const r of results) {
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

    const metrics = Object.entries(result.metrics);
    if (metrics.length > 0) {
      console.log("    Metrics:");
      for (const [k, v] of metrics) console.log(`      - ${k}: ${v}`);
    }

    if (result.logs && result.logs.length) {
      // Only show failure-related logs and group them by test id
      const failLogs = result.logs.filter(
        (l) =>
          l.startsWith("[FAIL]") ||
          l.startsWith("[ERROR]") ||
          l.startsWith("[FATAL]") ||
          l.startsWith("[STACK]") ||
          l.startsWith("[DEBUG-FAIL]") ||
          l.startsWith("[DEBUG-FAIL-CONTEXT]")
      );
      const hasFails = failLogs.length > 0;
      if (hasFails) {
        // Group failure logs by test id
        const byId = new Map<string, string[]>();
        function getTestIdFromLogLine(line: string): string | undefined {
          if (line.startsWith("[FAIL]")) {
            const m = line.match(/^\[FAIL\]\s+([^:]+):/);
            return m?.[1];
          }
          if (line.startsWith("[DEBUG-FAIL]")) {
            try {
              const parsed = JSON.parse(line.replace(/^\[DEBUG-FAIL\] /, ""));
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
                line.replace(/^\[DEBUG-FAIL-CONTEXT\] /, "")
              );
              return String(parsed?.id ?? "");
            } catch {
              /* intentionally ignored */
            }
          }
          return;
        }
        for (const line of failLogs) {
          const id = getTestIdFromLogLine(line);
          const key = id ?? "__general__";
          const arr = byId.get(key) ?? [];
          arr.push(line);
          byId.set(key, arr);
        }

        console.log(
          `    ${colors.bold}Failure details (grouped):${colors.reset}`
        );
        for (const [groupId, lines] of byId) {
          if (groupId !== "__general__") {
            console.log(`      ${colors.underline}${groupId}${colors.reset}`);
          }
          const debugIds = new Set<string>();
          for (const l of lines) {
            if (l.startsWith("[DEBUG-FAIL]")) {
              try {
                const parsed = JSON.parse(l.replace(/^\[DEBUG-FAIL\] /, ""));
                if (parsed?.id) debugIds.add(String(parsed.id));
              } catch {
                /* intentionally ignored */
              }
            }
          }
          for (const line of lines) {
            if (line.startsWith("[FAIL]")) {
              const m = line.match(/^\[FAIL\]\s+([^:]+):/);
              const failId = m?.[1];
              if (failId && debugIds.has(failId)) continue;
              console.log(`        ${colors.red}${line}${colors.reset}`);
            } else if (
              line.startsWith("[ERROR]") ||
              line.startsWith("[FATAL]")
            ) {
              console.log(`        ${colors.yellow}${line}${colors.reset}`);
            } else if (line.startsWith("[STACK]")) {
              console.log(`        ${colors.gray}${line}${colors.reset}`);
            } else if (line.startsWith("[DEBUG-FAIL]")) {
              const payload = line.replace(/^\[DEBUG-FAIL\] /, "");
              try {
                const parsed = JSON.parse(payload);
                const { message, diff, expected, actual } = parsed;
                if (message)
                  console.log(
                    `        ${colors.bold}${message}${colors.reset}`
                  );
                if (diff && Array.isArray(diff)) {
                  for (const dLine of diff)
                    console.log("          " + colorizeDiffLine(dLine));
                } else {
                  console.log("          expected:");
                  console.log(
                    colors.green +
                      "            " +
                      JSON.stringify(expected, null, 2)
                        .split("\n")
                        .join("\n            ") +
                      colors.reset
                  );
                  console.log("          actual:");
                  console.log(
                    colors.red +
                      "            " +
                      JSON.stringify(actual, null, 2)
                        .split("\n")
                        .join("\n            ") +
                      colors.reset
                  );
                }
                const suggestions = suggestFixFromDiff(parsed);
                if (suggestions.length) {
                  console.log(
                    `          ${colors.bold}Suggested fix:${colors.reset}`
                  );
                  for (const s of suggestions)
                    console.log(`            • ${s}`);
                }
              } catch {
                console.log(`        ${line}`);
              }
            } else if (line.startsWith("[DEBUG-FAIL-CONTEXT]")) {
              const payload = line.replace(/^\[DEBUG-FAIL-CONTEXT\] /, "");
              try {
                const ctx = JSON.parse(payload) as Record<string, unknown>;
                console.log(`        ${colors.gray}context:${colors.reset}`);
                if (ctx.tool_schema) {
                  console.log(
                    colors.gray +
                      "          tool schema: " +
                      JSON.stringify(ctx.tool_schema, null, 2)
                        .split("\n")
                        .join("\n            ") +
                      colors.reset
                  );
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
                      String(ctx.raw_model_text)
                        .split("\n")
                        .join("\n            ") +
                      colors.reset
                  );
                }
                if (ctx.parsed_tool_calls) {
                  console.log(
                    colors.gray +
                      "          parsed tool calls: " +
                      JSON.stringify(ctx.parsed_tool_calls, null, 2)
                        .split("\n")
                        .join("\n            ") +
                      colors.reset
                  );
                }
                if (ctx.ground_truth) {
                  console.log(
                    colors.gray +
                      "          ground truth: " +
                      JSON.stringify(ctx.ground_truth, null, 2)
                        .split("\n")
                        .join("\n            ") +
                      colors.reset
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
              } catch {
                console.log(`        ${line}`);
              }
            }
          }
        }
      } else {
        // Compact debug lines on success
        const info = result.logs.filter(
          (l) => l.startsWith("[INFO]") || l.startsWith("[PASS]")
        );
        for (const line of info)
          console.log(`      ${colors.gray}${line}${colors.reset}`);
      }
    }
  }

  console.log("\n------------------------------------\n");
}
