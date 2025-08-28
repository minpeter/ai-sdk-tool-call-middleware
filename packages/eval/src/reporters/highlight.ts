import { EvaluationResult } from "../interfaces";
import { diffLines } from "diff";

// Reuse color codes from console reporter style
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  bold: "\x1b[1m",
};

function highlightDiff(expected: string, actual: string): string {
  const parts = diffLines(expected, actual);
  return parts
    .map(p => {
      if (p.added) return `${colors.red}+ ${p.value}${colors.reset}`;
      if (p.removed) return `${colors.green}- ${p.value}${colors.reset}`;
      return `  ${p.value}`;
    })
    .join("");
}

export function highlightReporter(results: EvaluationResult[]): void {
  console.log("\n--- 🔍 BFCL Highlight Report ---");
  for (const res of results) {
    const { model, benchmark, result } = res;
    const status = result.success
      ? `${colors.green}✔ SUCCESS${colors.reset}`
      : `${colors.red}✖ FAILURE${colors.reset}`;

    console.log(
      `\n ${colors.cyan}[${model}]${colors.reset} - ${colors.magenta}${benchmark}${colors.reset}`
    );
    console.log(
      `  └ ${status} | Score: ${colors.yellow}${result.score.toFixed(2)}${colors.reset}`
    );

    if (result.metrics && Object.keys(result.metrics).length > 0) {
      console.log("    Metrics:");
      for (const [k, v] of Object.entries(result.metrics)) {
        console.log(`      - ${k}: ${v}`);
      }
    }

    // If logs exist, try to extract failed cases and show diffs
    const logs = result.logs ?? [];
    const failLines = logs.filter(l => l.startsWith("[FAIL]") || l.startsWith("[ERROR]") || l.startsWith("[STACK]"));
    if (failLines.length > 0) {
      console.log(`\n    ${colors.red}Failed cases (highlights):${colors.reset}`);
      for (const fl of failLines) {
        console.log(`      - ${fl}`);
      }
    }

    // Attempt to display a diff for any logged rawToolCalls lines
    const rawLines = logs.filter(l => l.includes("rawToolCalls="));
    if (rawLines.length > 0) {
      for (const rl of rawLines) {
        try {
          const payload = rl.split(/rawToolCalls=/)[1];
          // payload may be JSON followed by other props, try to parse first JSON array
          const arrMatch = payload.match(/(\[.*\])/s);
          if (arrMatch) {
            const actual = JSON.stringify(JSON.parse(arrMatch[1]), null, 2);
            // We don't have the expected in logs; show actual only with cyan header
            console.log(`\n    ${colors.cyan}Tool calls (actual):${colors.reset}\n${actual}`);
          }
        } catch (e) {
          // ignore parse errors
        }
      }
    }
  }
  console.log("\n---------------------------\n");
}

