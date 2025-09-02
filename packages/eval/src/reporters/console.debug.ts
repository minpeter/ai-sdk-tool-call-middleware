import { EvaluationResult } from "@/interfaces";

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
      const allowedLine = (diff as unknown[]).find((d: unknown) =>
        String(d).startsWith("- expected one of:")
      ) as string | undefined;
      if (allowedLine) {
        const allowed = allowedLine.replace("- expected one of: ", "");
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
      // Print only failure-related logs prominently. Pass logs stay compact.
      const failLogs = result.logs.filter(
        l =>
          l.startsWith("[FAIL]") ||
          l.startsWith("[ERROR]") ||
          l.startsWith("[FATAL]") ||
          l.startsWith("[STACK]") ||
          l.startsWith("[DEBUG-FAIL]") ||
          l.startsWith("[DEBUG-CONTEXT]")
      );
      const hasFails = failLogs.length > 0;
      if (hasFails) {
        console.log(`    ${colors.bold}Failure details:${colors.reset}`);
        // Build set of IDs that have structured debug entries to prevent duplicate prints
        const debugIds = new Set<string>();
        for (const l of failLogs) {
          if (l.startsWith("[DEBUG-FAIL]")) {
            try {
              const parsed = JSON.parse(l.replace(/^\[DEBUG-FAIL\] /, ""));
              if (parsed?.id) debugIds.add(String(parsed.id));
            } catch {
              // ignore JSON parse errors for debug lines
            }
          }
        }
        // Map id -> context payload if present
        const contextById = new Map<string, any>();
        for (const line of failLogs) {
          if (line.startsWith("[DEBUG-CONTEXT]")) {
            const payload = line.replace(/^\[DEBUG-CONTEXT\] /, "");
            try {
              const parsed = JSON.parse(payload);
              if (parsed?.id) contextById.set(String(parsed.id), parsed);
            } catch {
              // ignore
            }
          }
        }

        for (const line of failLogs) {
          // Highlight test id and reasons
          if (line.startsWith("[FAIL]")) {
            // Skip duplicate [FAIL] if we also have a [DEBUG-FAIL] for same id
            const m = line.match(/^\[FAIL\]\s+([^:]+):/);
            const failId = m?.[1];
            if (failId && debugIds.has(failId)) continue;
            console.log(`      ${colors.red}${line}${colors.reset}`);
          } else if (line.startsWith("[ERROR]") || line.startsWith("[FATAL]")) {
            console.log(`      ${colors.yellow}${line}${colors.reset}`);
          } else if (line.startsWith("[STACK]")) {
            console.log(`      ${colors.gray}${line}${colors.reset}`);
          } else if (line.startsWith("[DEBUG-FAIL]")) {
            // Attempt to pretty print embedded diffs
            const payload = line.replace(/^\[DEBUG-FAIL\] /, "");
            try {
              const parsed = JSON.parse(payload);
              const { id, expected, actual, message, diff } = parsed;
              console.log(
                `      ${colors.underline}${id}${colors.reset} ${message ? "- " + message : ""}`
              );
              if (diff && Array.isArray(diff)) {
                for (const dLine of diff)
                  console.log("        " + colorizeDiffLine(dLine));
              } else {
                console.log("        expected:");
                console.log(
                  colors.green +
                    "          " +
                    JSON.stringify(expected, null, 2)
                      .split("\n")
                      .join("\n          ") +
                    colors.reset
                );
                console.log("        actual:");
                console.log(
                  colors.red +
                    "          " +
                    JSON.stringify(actual, null, 2)
                      .split("\n")
                      .join("\n          ") +
                    colors.reset
                );
              }
              const suggestions = suggestFixFromDiff(parsed);
              if (suggestions.length) {
                console.log(
                  `        ${colors.bold}Suggested fix:${colors.reset}`
                );
                for (const s of suggestions) console.log(`          • ${s}`);
              }

              // If we have a detailed debug context for this id, pretty print it here
              const ctx = contextById.get(String(id));
              if (ctx) {
                console.log(`        ${colors.bold}Context:${colors.reset}`);
                const printSection = (title: string, value: unknown) => {
                  console.log(
                    `          ${colors.cyan}${title}:${colors.reset}`
                  );
                  const str = (() => {
                    try {
                      return JSON.stringify(value, null, 2);
                    } catch {
                      return String(value);
                    }
                  })();
                  console.log(
                    "            " +
                      str
                        .split("\n")
                        .map(l => l)
                        .join("\n            ")
                  );
                };
                try {
                  printSection("modelId", ctx.modelId);
                  printSection("config", ctx.config);
                  // Condensed tool info
                  try {
                    const toolNames = Array.isArray(ctx.toolsOriginal)
                      ? (ctx.toolsOriginal as Array<{ name?: string }>).map(
                          t => t?.name
                        )
                      : [];
                    printSection("toolNames", toolNames);
                  } catch {}
                  try {
                    const inputTypes = Array.isArray(ctx.toolsTransformed)
                      ? (
                          ctx.toolsTransformed as Array<{
                            inputSchema?: { type?: string };
                          }>
                        ).map(
                          t =>
                            (t?.inputSchema as { type?: string } | undefined)
                              ?.type
                        )
                      : [];
                    printSection("toolInputTypes", inputTypes);
                  } catch {}
                  try {
                    const nameMapKeys = ctx.nameMap
                      ? Object.keys(ctx.nameMap as Record<string, unknown>)
                      : [];
                    printSection("nameMapKeys", nameMapKeys);
                  } catch {}
                  try {
                    const messagesArr = Array.isArray(ctx.messages)
                      ? (ctx.messages as unknown[])
                      : [];
                    printSection("messagesCount", messagesArr.length);
                    if (messagesArr.length > 0) {
                      printSection("message[0]", messagesArr[0]);
                    }
                  } catch {}
                  if (ctx.rawOutput) printSection("rawOutput", ctx.rawOutput);
                  if (ctx.parse) printSection("parse", ctx.parse);
                  if (ctx.groundTruth)
                    printSection("groundTruth", ctx.groundTruth);
                  // Include original tool-call text if present in middlewareDebug
                  try {
                    const events = Array.isArray((ctx as any).middlewareDebug)
                      ? ((ctx as any).middlewareDebug as Array<{
                          event?: string;
                          payload?: any;
                        }>)
                      : [];
                    const latestParse = [...events]
                      .reverse()
                      .find(e => e?.event === "parse-summary" && e?.payload);
                    if (latestParse && latestParse.payload) {
                      const origin = latestParse.payload.originalText as
                        | string
                        | undefined;
                      if (origin && origin.trim().length > 0) {
                        console.log(
                          `          ${colors.cyan}originalToolText:${colors.reset}`
                        );
                        console.log(
                          "            " +
                            origin
                              .split("\n")
                              .map(l => l)
                              .join("\n            ")
                        );
                      }
                      if (latestParse.payload.toolCalls) {
                        printSection(
                          "parsedToolCalls",
                          latestParse.payload.toolCalls
                        );
                      }
                    }
                    const rawTexts = events
                      .filter(e => e.event === "raw-text")
                      .map(e => e.payload?.text);
                    if (rawTexts.length > 0) {
                      printSection("rawTextSample[0]", rawTexts[0]);
                    }
                  } catch {}
                } catch {
                  // ignore errors while pretty-printing context
                }
              }
            } catch {
              console.log(`      ${line}`);
            }
          } else if (line.startsWith("[DEBUG-CONTEXT]")) {
            // Skip here; printed alongside its matching [DEBUG-FAIL]
          }
        }
      } else {
        // Compact debug lines on success
        const info = result.logs.filter(
          l => l.startsWith("[INFO]") || l.startsWith("[PASS]")
        );
        for (const line of info)
          console.log(`      ${colors.gray}${line}${colors.reset}`);
      }
    }
  }

  console.log("\n------------------------------------\n");
}
