import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SCORED = resolve(
  process.env.BENCH_SCORED ??
    "benchmarks/glm-5.2-tool-calling/results/latest/scored.jsonl"
);
const OUT_DIR = resolve(process.env.BENCH_ANALYSIS_OUT ?? dirname(SCORED));
const SENSITIVITY_SCORED = process.env.BENCH_SENSITIVITY_SCORED
  ? resolve(process.env.BENCH_SENSITIVITY_SCORED)
  : null;

const ARM_ORDER = [
  "native",
  "glm5",
  "hermes",
  "morphXml",
  "yamlXml",
  "qwen3Coder",
  "sijawaraDetailed",
  "sijawaraConcise",
  "uiTars",
] as const;
const CATEGORY_ORDER = [
  "simple_python",
  "simple_java",
  "simple_javascript",
  "multiple",
  "parallel",
  "parallel_multiple",
  "irrelevance",
  "live_simple",
  "live_multiple",
  "live_parallel",
  "live_parallel_multiple",
  "live_irrelevance",
  "live_relevance",
] as const;
const COLORS: Record<string, string> = {
  native: "#111827",
  glm5: "#dc2626",
  hermes: "#7c3aed",
  morphXml: "#059669",
  yamlXml: "#d97706",
  qwen3Coder: "#2563eb",
  sijawaraDetailed: "#db2777",
  sijawaraConcise: "#f472b6",
  uiTars: "#0891b2",
};
const COMPACT_LABELS: Record<string, string> = {
  native: "Native",
  glm5: "GLM-5.2",
  hermes: "Hermes",
  morphXml: "Morph",
  yamlXml: "YAML",
  qwen3Coder: "Qwen",
  sijawaraDetailed: "Sija-D",
  sijawaraConcise: "Sija-C",
  uiTars: "UI-TARS",
};
const EFFICIENCY_LABEL_OFFSETS: Record<
  string,
  { deltaX: number; deltaY: number }
> = {
  native: { deltaX: 14, deltaY: -10 },
  glm5: { deltaX: 14, deltaY: 10 },
  hermes: { deltaX: 14, deltaY: 26 },
  morphXml: { deltaX: 14, deltaY: -10 },
  yamlXml: { deltaX: 14, deltaY: 10 },
  qwen3Coder: { deltaX: 14, deltaY: -18 },
  sijawaraDetailed: { deltaX: 14, deltaY: 16 },
  sijawaraConcise: { deltaX: 14, deltaY: -12 },
  uiTars: { deltaX: 14, deltaY: 14 },
};
const UNKNOWN_ARM_COLORS = [
  "#475569",
  "#a16207",
  "#4f46e5",
  "#be123c",
  "#15803d",
] as const;
const CSV_ESCAPE_PATTERN = /[",\n]/;
const FUNCTION_ERROR_PATTERN = /wrong_func_name/;
const MISSING_CALL_PATTERN = /relevance:missing_call/;
const TYPE_ERROR_PATTERN = /type_error/;
const UNEXPECTED_CALL_PATTERN = /irrelevance:unexpected_call/;
const VALUE_ERROR_PATTERN = /value_error/;
const WRONG_COUNT_PATTERN = /wrong_count/;
const WRONG_NUMBER_PATTERN = /Wrong number/;

type ArmId = string;
type Category = (typeof CATEGORY_ORDER)[number];

function armColor(arm: ArmId): string {
  const configured = COLORS[arm];
  if (configured) {
    return configured;
  }
  let hash = 0;
  for (let index = 0; index < arm.length; index += 1) {
    hash = (hash * 31 + arm.charCodeAt(index)) % 2_147_483_647;
  }
  return UNKNOWN_ARM_COLORS[hash % UNKNOWN_ARM_COLORS.length];
}

function compactArmLabel(arm: ArmId): string {
  return COMPACT_LABELS[arm] ?? arm;
}

function efficiencyLabelOffset(arm: ArmId): { deltaX: number; deltaY: number } {
  return (
    EFFICIENCY_LABEL_OFFSETS[arm] ?? {
      deltaX: 14,
      deltaY: 14,
    }
  );
}

interface ScoredRow {
  arm: ArmId;
  attempts: number;
  bfclCorrect: boolean | null;
  callShapeValid: boolean;
  calls: Array<{ arguments: unknown; name: string }>;
  caseId: string;
  category: Category;
  error?: string;
  evaluable: boolean;
  latencyMs: number;
  parserErrors: string[];
  protocolValid: boolean;
  scoreErrors: string[];
  scoreErrorType?: string;
  strictCorrect: boolean;
  textLeak: boolean;
  trial: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

interface Summary {
  accuracy: number | null;
  arm?: ArmId;
  availability: number;
  bfclAccuracy: number | null;
  category?: Category;
  correct: number;
  endToEndAccuracy: number;
  evaluable: number;
  inputTokensMean: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  lower95: number | null;
  malformedCalls: number;
  outputTokensMean: number | null;
  parserErrors: number;
  protocolIntegrity: number | null;
  textLeaks: number;
  total: number;
  transportErrors: number;
  upper95: number | null;
}

interface FailureSummary {
  arm: ArmId;
  malformed: number;
  missingCall: number;
  otherSemantic: number;
  provider: number;
  textLeak: number;
  unexpectedCall: number;
  wrongCount: number;
  wrongFunction: number;
  wrongType: number;
  wrongValue: number;
}

interface PairedSummary {
  arm: Exclude<ArmId, "native">;
  comparable: number;
  conditionalSemanticComparable: number;
  conditionalSemanticConversionLoss: number;
  conditionalSemanticExactP: number;
  conditionalSemanticRecovery: number;
  conditionalStrictComparable: number;
  conditionalStrictConversionLoss: number;
  conditionalStrictExactP: number;
  conditionalStrictRecovery: number;
  conversionLoss: number;
  conversionLossRate: number | null;
  mcnemarExactP: number;
  nativeCorrect: number;
  nativeIncorrect: number;
  netVsNative: number;
  recovery: number;
  recoveryRate: number | null;
}

function exactTwoSidedMcNemar(
  conversionLoss: number,
  recovery: number
): number {
  const discordant = conversionLoss + recovery;
  if (discordant === 0) {
    return 1;
  }
  const tailLimit = Math.min(conversionLoss, recovery);
  let probability = 0.5 ** discordant;
  let cumulative = probability;
  for (let successes = 1; successes <= tailLimit; successes += 1) {
    probability *= (discordant - successes + 1) / successes;
    cumulative += probability;
  }
  return Math.min(1, 2 * cumulative);
}

interface SensitivitySummary {
  arm: "sijawaraDetailed" | "sijawaraConcise";
  originalAccuracy: number;
  originalCorrect: number;
  recovered: number;
  total: number;
  trimmedAccuracy: number;
  trimmedCorrect: number;
}

function loadJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function mean(values: number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratioOrNull(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function quantile(values: number[], probability: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower];
  }
  return sorted[lower] * (upper - index) + sorted[upper] * (index - lower);
}

function wilson(
  successes: number,
  total: number
): [number | null, number | null] {
  if (total === 0) {
    return [null, null];
  }
  const z = 1.959_963_984_540_054;
  const proportion = successes / total;
  const denominator = 1 + z ** 2 / total;
  const center = (proportion + z ** 2 / (2 * total)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt(
      (proportion * (1 - proportion)) / total + z ** 2 / (4 * total ** 2)
    );
  return [center - margin, center + margin];
}

function summarize(rows: ScoredRow[]): Summary {
  const evaluableRows = rows.filter((row) => row.evaluable);
  const correct = evaluableRows.filter((row) => row.strictCorrect).length;
  const bfclCorrect = evaluableRows.filter((row) => row.bfclCorrect).length;
  const [lower95, upper95] = wilson(correct, evaluableRows.length);
  return {
    accuracy:
      evaluableRows.length === 0 ? null : correct / evaluableRows.length,
    availability: rows.length === 0 ? 0 : evaluableRows.length / rows.length,
    bfclAccuracy:
      evaluableRows.length === 0 ? null : bfclCorrect / evaluableRows.length,
    correct,
    endToEndAccuracy: rows.length === 0 ? 0 : correct / rows.length,
    evaluable: evaluableRows.length,
    inputTokensMean: mean(
      evaluableRows.flatMap((row) =>
        row.usage?.inputTokens === undefined ? [] : [row.usage.inputTokens]
      )
    ),
    latencyP50Ms: quantile(
      evaluableRows.map((row) => row.latencyMs),
      0.5
    ),
    latencyP95Ms: quantile(
      evaluableRows.map((row) => row.latencyMs),
      0.95
    ),
    lower95,
    malformedCalls: rows.filter((row) => !row.callShapeValid).length,
    outputTokensMean: mean(
      evaluableRows.flatMap((row) =>
        row.usage?.outputTokens === undefined ? [] : [row.usage.outputTokens]
      )
    ),
    parserErrors: rows.filter((row) => row.parserErrors.length > 0).length,
    protocolIntegrity:
      evaluableRows.length === 0
        ? null
        : evaluableRows.filter((row) => row.protocolValid).length /
          evaluableRows.length,
    textLeaks: rows.filter((row) => row.textLeak).length,
    total: rows.length,
    transportErrors: rows.length - evaluableRows.length,
    upper95,
  };
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    groups.set(value, [...(groups.get(value) ?? []), row]);
  }
  return groups;
}

function classifyFailure(
  row: ScoredRow
): keyof Omit<FailureSummary, "arm"> | null {
  if (row.strictCorrect) {
    return null;
  }
  if (!row.evaluable) {
    return "provider";
  }
  if (!row.callShapeValid || row.parserErrors.length > 0) {
    return "malformed";
  }
  if (row.textLeak) {
    return "textLeak";
  }
  const errorType = row.scoreErrorType ?? "";
  const errorText = row.scoreErrors.join(" ");
  if (UNEXPECTED_CALL_PATTERN.test(errorType)) {
    return "unexpectedCall";
  }
  if (
    MISSING_CALL_PATTERN.test(errorType) ||
    WRONG_NUMBER_PATTERN.test(errorText)
  ) {
    return row.calls.length === 0 ? "missingCall" : "wrongCount";
  }
  if (WRONG_COUNT_PATTERN.test(errorType)) {
    return row.calls.length === 0 ? "missingCall" : "wrongCount";
  }
  if (FUNCTION_ERROR_PATTERN.test(errorType)) {
    return "wrongFunction";
  }
  if (TYPE_ERROR_PATTERN.test(errorType)) {
    return "wrongType";
  }
  if (VALUE_ERROR_PATTERN.test(errorType)) {
    return "wrongValue";
  }
  return "otherSemantic";
}

function summarizePairedVsNative(
  byArm: Map<string, ScoredRow[]>,
  arms: readonly ArmId[]
): PairedSummary[] {
  const nativeByCase = new Map(
    (byArm.get("native") ?? []).map((row) => [
      `${row.category}\u0000${row.caseId}\u0000${row.trial}`,
      row,
    ])
  );
  const nonNativeArms = arms.filter(
    (arm): arm is Exclude<ArmId, "native"> => arm !== "native"
  );
  return nonNativeArms.map((arm) => {
    let comparable = 0;
    let conditionalSemanticComparable = 0;
    let conditionalSemanticConversionLoss = 0;
    let conditionalSemanticRecovery = 0;
    let conditionalStrictComparable = 0;
    let conditionalStrictConversionLoss = 0;
    let conditionalStrictRecovery = 0;
    let conversionLoss = 0;
    let nativeCorrect = 0;
    let nativeIncorrect = 0;
    let recovery = 0;
    for (const row of byArm.get(arm) ?? []) {
      const native = nativeByCase.get(
        `${row.category}\u0000${row.caseId}\u0000${row.trial}`
      );
      if (!native) {
        continue;
      }
      comparable += 1;
      nativeCorrect += Number(native.strictCorrect);
      nativeIncorrect += Number(!native.strictCorrect);
      conversionLoss += Number(native.strictCorrect && !row.strictCorrect);
      recovery += Number(!native.strictCorrect && row.strictCorrect);
      if (native.evaluable && row.evaluable) {
        conditionalStrictComparable += 1;
        conditionalStrictConversionLoss += Number(
          native.strictCorrect && !row.strictCorrect
        );
        conditionalStrictRecovery += Number(
          !native.strictCorrect && row.strictCorrect
        );
        conditionalSemanticComparable += 1;
        const nativeSemanticCorrect = native.bfclCorrect === true;
        const armSemanticCorrect = row.bfclCorrect === true;
        conditionalSemanticConversionLoss += Number(
          nativeSemanticCorrect && !armSemanticCorrect
        );
        conditionalSemanticRecovery += Number(
          !nativeSemanticCorrect && armSemanticCorrect
        );
      }
    }
    return {
      arm,
      comparable,
      conditionalSemanticComparable,
      conditionalSemanticConversionLoss,
      conditionalSemanticExactP: exactTwoSidedMcNemar(
        conditionalSemanticConversionLoss,
        conditionalSemanticRecovery
      ),
      conditionalSemanticRecovery,
      conditionalStrictComparable,
      conditionalStrictConversionLoss,
      conditionalStrictExactP: exactTwoSidedMcNemar(
        conditionalStrictConversionLoss,
        conditionalStrictRecovery
      ),
      conditionalStrictRecovery,
      conversionLoss,
      conversionLossRate: ratioOrNull(conversionLoss, nativeCorrect),
      nativeCorrect,
      nativeIncorrect,
      netVsNative: recovery - conversionLoss,
      mcnemarExactP: exactTwoSidedMcNemar(conversionLoss, recovery),
      recovery,
      recoveryRate: ratioOrNull(recovery, nativeIncorrect),
    };
  });
}

function csv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) {
    return "";
  }
  const columns = Object.keys(rows[0]);
  const cell = (value: unknown) => {
    const text = value === null || value === undefined ? "" : String(value);
    return CSV_ESCAPE_PATTERN.test(text)
      ? `"${text.replaceAll('"', '""')}"`
      : text;
  };
  return `${columns.join(",")}\n${rows
    .map((row) => columns.map((column) => cell(row[column])).join(","))
    .join("\n")}\n`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function svgFrame(
  width: number,
  height: number,
  title: string,
  content: string
) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chart-title">
  <title id="chart-title">${escapeXml(title)}</title>
  <rect width="100%" height="100%" fill="#ffffff"/>
  <style>text{font-family:Inter,Arial,sans-serif;fill:#111827}.title{font-size:24px;font-weight:700}.label{font-size:14px}.small{font-size:12px;fill:#4b5563}.value{font-size:13px;font-weight:700}.grid{stroke:#e5e7eb;stroke-width:1}</style>
  <text x="40" y="38" class="title">${escapeXml(title)}</text>
  ${content}
</svg>\n`;
}

function accuracySvg(summaries: Array<Summary & { arm: ArmId }>): string {
  const width = 1040;
  const left = 190;
  const top = 75;
  const chartWidth = 780;
  const rowHeight = 58;
  const height = Math.max(240, top + summaries.length * rowHeight + 45);
  const lines: string[] = [];
  for (let tick = 0; tick <= 100; tick += 20) {
    const x = left + (tick / 100) * chartWidth;
    lines.push(
      `<line x1="${x}" y1="${top - 10}" x2="${x}" y2="${height - 45}" class="grid"/>`
    );
    lines.push(
      `<text x="${x}" y="${height - 22}" text-anchor="middle" class="small">${tick}%</text>`
    );
  }
  summaries.forEach((summary, index) => {
    const y = top + index * rowHeight;
    const accuracy = summary.accuracy ?? 0;
    const lower = summary.lower95 ?? 0;
    const upper = summary.upper95 ?? 0;
    lines.push(
      `<text x="${left - 14}" y="${y + 22}" text-anchor="end" class="label">${escapeXml(summary.arm)}</text>`
    );
    lines.push(
      `<rect x="${left}" y="${y + 5}" width="${accuracy * chartWidth}" height="25" rx="5" fill="${armColor(summary.arm)}"/>`
    );
    lines.push(
      `<line x1="${left + lower * chartWidth}" y1="${y + 17.5}" x2="${left + upper * chartWidth}" y2="${y + 17.5}" stroke="#111827" stroke-width="2"/>`
    );
    lines.push(
      `<line x1="${left + lower * chartWidth}" y1="${y + 11}" x2="${left + lower * chartWidth}" y2="${y + 24}" stroke="#111827"/>`
    );
    lines.push(
      `<line x1="${left + upper * chartWidth}" y1="${y + 11}" x2="${left + upper * chartWidth}" y2="${y + 24}" stroke="#111827"/>`
    );
    lines.push(
      `<text x="${left + accuracy * chartWidth + 8}" y="${y + 23}" class="value">${(accuracy * 100).toFixed(1)}%</text>`
    );
  });
  return svgFrame(
    width,
    height,
    "Strict BFCL accuracy by protocol (95% Wilson CI)",
    lines.join("\n")
  );
}

function semanticVsStrictSvg(
  summaries: Array<Summary & { arm: ArmId }>
): string {
  const width = 1040;
  const left = 190;
  const top = 80;
  const chartWidth = 780;
  const rowHeight = 65;
  const height = Math.max(250, top + summaries.length * rowHeight + 60);
  const lines: string[] = [];
  for (let tick = 0; tick <= 100; tick += 20) {
    const x = left + (tick / 100) * chartWidth;
    lines.push(
      `<line x1="${x}" y1="${top - 10}" x2="${x}" y2="${height - 60}" class="grid"/>`
    );
    lines.push(
      `<text x="${x}" y="${height - 34}" text-anchor="middle" class="small">${tick}%</text>`
    );
  }
  summaries.forEach((summary, index) => {
    const y = top + index * rowHeight;
    const semantic = summary.bfclAccuracy ?? 0;
    const strict = summary.accuracy ?? 0;
    lines.push(
      `<text x="${left - 14}" y="${y + 28}" text-anchor="end" class="label">${escapeXml(summary.arm)}</text>`
    );
    lines.push(
      `<rect x="${left}" y="${y + 5}" width="${semantic * chartWidth}" height="18" rx="4" fill="${armColor(summary.arm)}" opacity="0.3"/>`
    );
    lines.push(
      `<rect x="${left}" y="${y + 28}" width="${strict * chartWidth}" height="18" rx="4" fill="${armColor(summary.arm)}"/>`
    );
    lines.push(
      `<text x="${left + semantic * chartWidth + 7}" y="${y + 19}" class="small">semantic ${(semantic * 100).toFixed(1)}%</text>`
    );
    lines.push(
      `<text x="${left + strict * chartWidth + 7}" y="${y + 43}" class="value">strict ${(strict * 100).toFixed(1)}%</text>`
    );
  });
  return svgFrame(
    width,
    height,
    "BFCL semantic accuracy vs protocol-strict accuracy",
    lines.join("\n")
  );
}

function sijawaraSensitivitySvg(rows: SensitivitySummary[]): string {
  const width = 1040;
  const height = 420;
  const left = 210;
  const top = 95;
  const chartWidth = 760;
  const rowHeight = 115;
  const lines: string[] = [];
  for (let tick = 0; tick <= 100; tick += 20) {
    const x = left + (tick / 100) * chartWidth;
    lines.push(
      `<line x1="${x}" y1="${top - 15}" x2="${x}" y2="${height - 70}" class="grid"/>`
    );
    lines.push(
      `<text x="${x}" y="${height - 45}" text-anchor="middle" class="small">${tick}%</text>`
    );
  }
  rows.forEach((row, index) => {
    const y = top + index * rowHeight;
    lines.push(
      `<text x="${left - 14}" y="${y + 42}" text-anchor="end" class="label">${escapeXml(compactArmLabel(row.arm))}</text>`
    );
    lines.push(
      `<rect x="${left}" y="${y + 5}" width="${row.originalAccuracy * chartWidth}" height="28" rx="5" fill="${armColor(row.arm)}" opacity="0.35"/>`
    );
    lines.push(
      `<rect x="${left}" y="${y + 43}" width="${row.trimmedAccuracy * chartWidth}" height="28" rx="5" fill="${armColor(row.arm)}"/>`
    );
    lines.push(
      `<text x="${left + row.originalAccuracy * chartWidth + 8}" y="${y + 25}" class="small">observed ${(row.originalAccuracy * 100).toFixed(1)}%</text>`
    );
    lines.push(
      `<text x="${left + row.trimmedAccuracy * chartWidth + 8}" y="${y + 64}" class="value">trim sensitivity ${(row.trimmedAccuracy * 100).toFixed(1)}% (+${row.recovered})</text>`
    );
  });
  lines.push(
    `<text x="${left}" y="${height - 16}" class="small">Diagnostic counterfactual: recursively trim decoded string arguments, then re-run the official BFCL checker.</text>`
  );
  return svgFrame(
    width,
    height,
    "Sijawara whitespace sensitivity (not an observed benchmark score)",
    lines.join("\n")
  );
}

function availabilitySvg(summaries: Array<Summary & { arm: ArmId }>): string {
  const width = 1040;
  const left = 190;
  const top = 75;
  const chartWidth = 780;
  const rowHeight = 58;
  const height = Math.max(240, top + summaries.length * rowHeight + 45);
  const lines: string[] = [];
  for (let tick = 0; tick <= 100; tick += 20) {
    const x = left + (tick / 100) * chartWidth;
    lines.push(
      `<line x1="${x}" y1="${top - 10}" x2="${x}" y2="${height - 45}" class="grid"/>`
    );
  }
  summaries.forEach((summary, index) => {
    const y = top + index * rowHeight;
    lines.push(
      `<text x="${left - 14}" y="${y + 22}" text-anchor="end" class="label">${escapeXml(summary.arm)}</text>`
    );
    lines.push(
      `<rect x="${left}" y="${y + 5}" width="${summary.availability * chartWidth}" height="25" rx="5" fill="${armColor(summary.arm)}"/>`
    );
    lines.push(
      `<text x="${left + summary.availability * chartWidth - 8}" y="${y + 23}" text-anchor="end" class="value" fill="#ffffff">${(summary.availability * 100).toFixed(1)}%</text>`
    );
    lines.push(
      `<text x="${left + chartWidth + 10}" y="${y + 23}" class="small">${summary.transportErrors} provider errors</text>`
    );
  });
  return svgFrame(
    width,
    height,
    "Provider availability after configured retries",
    lines.join("\n")
  );
}

function latencySvg(summaries: Array<Summary & { arm: ArmId }>): string {
  // Keep room to the right of the longest p95 bar for its value label.
  const width = 1220;
  const left = 190;
  const top = 75;
  const chartWidth = 780;
  const rowHeight = 58;
  const height = Math.max(240, top + summaries.length * rowHeight + 45);
  const maxMs = Math.max(
    ...summaries.map((summary) => summary.latencyP95Ms ?? 0)
  );
  const scale = maxMs === 0 ? 0 : chartWidth / maxMs;
  const lines: string[] = [];
  summaries.forEach((summary, index) => {
    const y = top + index * rowHeight;
    const p50 = summary.latencyP50Ms ?? 0;
    const p95 = summary.latencyP95Ms ?? 0;
    lines.push(
      `<text x="${left - 14}" y="${y + 22}" text-anchor="end" class="label">${escapeXml(summary.arm)}</text>`
    );
    lines.push(
      `<rect x="${left}" y="${y + 5}" width="${p95 * scale}" height="25" rx="5" fill="${armColor(summary.arm)}" opacity="0.25"/>`
    );
    lines.push(
      `<rect x="${left}" y="${y + 5}" width="${p50 * scale}" height="25" rx="5" fill="${armColor(summary.arm)}"/>`
    );
    lines.push(
      `<text x="${left + p95 * scale + 8}" y="${y + 23}" class="value">p50 ${(p50 / 1000).toFixed(1)}s / p95 ${(p95 / 1000).toFixed(1)}s</text>`
    );
  });
  lines.push(
    `<text x="${left}" y="${height - 22}" class="small">Solid = p50, translucent extension = p95</text>`
  );
  return svgFrame(
    width,
    height,
    "End-to-end latency by protocol",
    lines.join("\n")
  );
}

function tokensSvg(summaries: Array<Summary & { arm: ArmId }>): string {
  const width = 1040;
  const left = 190;
  const top = 75;
  const chartWidth = 780;
  const rowHeight = 58;
  const height = Math.max(240, top + summaries.length * rowHeight + 45);
  const maxTokens = Math.max(
    ...summaries.map(
      (summary) =>
        (summary.inputTokensMean ?? 0) + (summary.outputTokensMean ?? 0)
    )
  );
  const scale = maxTokens === 0 ? 0 : chartWidth / maxTokens;
  const lines: string[] = [];
  summaries.forEach((summary, index) => {
    const y = top + index * rowHeight;
    const input = summary.inputTokensMean ?? 0;
    const output = summary.outputTokensMean ?? 0;
    lines.push(
      `<text x="${left - 14}" y="${y + 22}" text-anchor="end" class="label">${escapeXml(summary.arm)}</text>`
    );
    lines.push(
      `<rect x="${left}" y="${y + 5}" width="${input * scale}" height="25" rx="5" fill="${armColor(summary.arm)}"/>`
    );
    lines.push(
      `<rect x="${left + input * scale}" y="${y + 5}" width="${output * scale}" height="25" fill="#fbbf24"/>`
    );
    lines.push(
      `<text x="${left + (input + output) * scale + 8}" y="${y + 23}" class="value">${input.toFixed(0)} in + ${output.toFixed(0)} out</text>`
    );
  });
  return svgFrame(
    width,
    height,
    "Mean token use per request",
    lines.join("\n")
  );
}

function efficiencySvg(summaries: Array<Summary & { arm: ArmId }>): string {
  const width = 1040;
  const height = 650;
  const left = 100;
  const top = 80;
  const chartWidth = 850;
  const chartHeight = 480;
  const totals = summaries.map(
    (summary) =>
      (summary.inputTokensMean ?? 0) + (summary.outputTokensMean ?? 0)
  );
  const maxTokens = Math.max(1, ...totals) * 1.12;
  const lines: string[] = [];
  for (let tick = 0; tick <= 100; tick += 20) {
    const y = top + chartHeight - (tick / 100) * chartHeight;
    lines.push(
      `<line x1="${left}" y1="${y}" x2="${left + chartWidth}" y2="${y}" class="grid"/>`
    );
    lines.push(
      `<text x="${left - 12}" y="${y + 4}" text-anchor="end" class="small">${tick}%</text>`
    );
  }
  for (let tick = 0; tick <= 4; tick += 1) {
    const value = (maxTokens * tick) / 4;
    const x = left + (tick / 4) * chartWidth;
    lines.push(
      `<line x1="${x}" y1="${top}" x2="${x}" y2="${top + chartHeight}" class="grid"/>`
    );
    lines.push(
      `<text x="${x}" y="${top + chartHeight + 24}" text-anchor="middle" class="small">${value.toFixed(0)}</text>`
    );
  }
  summaries.forEach((summary, index) => {
    const total = totals[index];
    const accuracy = summary.accuracy ?? 0;
    const x = left + (total / maxTokens) * chartWidth;
    const y = top + chartHeight - accuracy * chartHeight;
    const labelOffset = efficiencyLabelOffset(summary.arm);
    lines.push(
      `<circle cx="${x}" cy="${y}" r="10" fill="${armColor(summary.arm)}" stroke="#ffffff" stroke-width="2"/>`
    );
    lines.push(
      `<text x="${x + labelOffset.deltaX}" y="${y + labelOffset.deltaY}" class="label">${escapeXml(compactArmLabel(summary.arm))}</text>`
    );
  });
  lines.push(
    `<text x="${left + chartWidth / 2}" y="${height - 25}" text-anchor="middle" class="label">Mean input + output tokens per request (lower is better)</text>`
  );
  return svgFrame(
    width,
    height,
    "Quality-efficiency frontier",
    lines.join("\n")
  );
}

function pairedVsNativeSvg(paired: PairedSummary[]): string {
  const width = 1120;
  const center = 560;
  const top = 85;
  const halfWidth = 390;
  const rowHeight = 62;
  const height = Math.max(240, top + paired.length * rowHeight + 65);
  const maxCount = Math.max(
    1,
    ...paired.flatMap((row) => [row.conversionLoss, row.recovery])
  );
  const scale = halfWidth / maxCount;
  const lines: string[] = [
    `<text x="40" y="62" class="small">End-to-end strict outcome; provider and parser failures count as incorrect</text>`,
    `<line x1="${center}" y1="${top - 20}" x2="${center}" y2="${height - 65}" stroke="#111827" stroke-width="2"/>`,
    `<text x="${center - halfWidth / 2}" y="${top - 30}" text-anchor="middle" class="small">Native correct → protocol wrong</text>`,
    `<text x="${center + halfWidth / 2}" y="${top - 30}" text-anchor="middle" class="small">Native wrong → protocol correct</text>`,
  ];
  paired.forEach((row, index) => {
    const y = top + index * rowHeight;
    const lossWidth = row.conversionLoss * scale;
    const recoveryWidth = row.recovery * scale;
    lines.push(
      `<text x="${center - halfWidth - 15}" y="${y + 24}" text-anchor="end" class="label">${escapeXml(compactArmLabel(row.arm))}</text>`
    );
    lines.push(
      `<rect x="${center - lossWidth}" y="${y + 5}" width="${lossWidth}" height="25" fill="#ef4444"/>`
    );
    lines.push(
      `<rect x="${center}" y="${y + 5}" width="${recoveryWidth}" height="25" fill="#22c55e"/>`
    );
    lines.push(
      `<text x="${center - lossWidth - 7}" y="${y + 23}" text-anchor="end" class="value">−${row.conversionLoss}</text>`
    );
    lines.push(
      `<text x="${center + recoveryWidth + 7}" y="${y + 23}" class="value">+${row.recovery}</text>`
    );
    lines.push(
      `<text x="${center + halfWidth + 12}" y="${y + 23}" class="small">net ${row.netVsNative >= 0 ? "+" : ""}${row.netVsNative}</text>`
    );
  });
  return svgFrame(
    width,
    height,
    "Paired outcome changes vs native",
    lines.join("\n")
  );
}

function heatColor(value: number): string {
  const clamped = Math.max(0, Math.min(1, value));
  const red = Math.round(239 + (34 - 239) * clamped);
  const green = Math.round(68 + (197 - 68) * clamped);
  const blue = Math.round(68 + (94 - 68) * clamped);
  return `rgb(${red},${green},${blue})`;
}

function heatmapSvg(
  matrix: Map<string, Summary>,
  categories: readonly Category[],
  arms: readonly ArmId[]
): string {
  const cellWidth = 140;
  const cellHeight = 42;
  const left = 250;
  const top = 120;
  // The previous content-derived width clipped the descriptive chart title.
  const width = Math.max(680, left + cellWidth * arms.length + 40);
  const height = top + cellHeight * categories.length + 45;
  const lines: string[] = [];
  arms.forEach((arm, index) => {
    const x = left + index * cellWidth + cellWidth / 2;
    lines.push(
      `<text x="${x}" y="${top - 15}" text-anchor="middle" class="small">${escapeXml(compactArmLabel(arm))}</text>`
    );
  });
  categories.forEach((category, rowIndex) => {
    const y = top + rowIndex * cellHeight;
    lines.push(
      `<text x="${left - 12}" y="${y + 27}" text-anchor="end" class="label">${escapeXml(category)}</text>`
    );
    arms.forEach((arm, columnIndex) => {
      const summary = matrix.get(`${category}\u0000${arm}`);
      const accuracy = summary?.accuracy ?? 0;
      const x = left + columnIndex * cellWidth;
      lines.push(
        `<rect x="${x + 1}" y="${y + 1}" width="${cellWidth - 2}" height="${cellHeight - 2}" rx="4" fill="${heatColor(accuracy)}"/>`
      );
      lines.push(
        `<text x="${x + cellWidth / 2}" y="${y + 27}" text-anchor="middle" class="value" fill="#111827">${summary?.accuracy === null || summary === undefined ? "N/A" : `${(accuracy * 100).toFixed(0)}%`}</text>`
      );
    });
  });
  return svgFrame(
    width,
    height,
    "Accuracy heatmap: protocol x BFCL category",
    lines.join("\n")
  );
}

function failureSvg(failures: FailureSummary[]): string {
  const width = 1160;
  const left = 190;
  const top = 85;
  const chartWidth = 880;
  const rowHeight = 58;
  const height = Math.max(300, top + failures.length * rowHeight + 100);
  const keys: Array<keyof Omit<FailureSummary, "arm">> = [
    "missingCall",
    "wrongValue",
    "wrongType",
    "wrongFunction",
    "wrongCount",
    "unexpectedCall",
    "textLeak",
    "malformed",
    "provider",
    "otherSemantic",
  ];
  const colors = [
    "#ef4444",
    "#f97316",
    "#eab308",
    "#84cc16",
    "#14b8a6",
    "#06b6d4",
    "#8b5cf6",
    "#d946ef",
    "#64748b",
    "#cbd5e1",
  ];
  const maxFailures = Math.max(
    1,
    ...failures.map((failure) =>
      keys.reduce((sum, key) => sum + failure[key], 0)
    )
  );
  const lines: string[] = [];
  failures.forEach((failure, rowIndex) => {
    const y = top + rowIndex * rowHeight;
    let x = left;
    lines.push(
      `<text x="${left - 14}" y="${y + 22}" text-anchor="end" class="label">${escapeXml(failure.arm)}</text>`
    );
    keys.forEach((key, index) => {
      const value = failure[key];
      const widthForValue = (value / maxFailures) * chartWidth;
      if (value > 0) {
        lines.push(
          `<rect x="${x}" y="${y + 5}" width="${widthForValue}" height="25" fill="${colors[index]}"/>`
        );
        if (widthForValue > 24) {
          lines.push(
            `<text x="${x + widthForValue / 2}" y="${y + 22}" text-anchor="middle" class="small">${value}</text>`
          );
        }
      }
      x += widthForValue;
    });
  });
  keys.forEach((key, index) => {
    const column = index % 5;
    const row = Math.floor(index / 5);
    const x = 190 + column * 180;
    const y = height - 55 + row * 22;
    lines.push(
      `<rect x="${x}" y="${y - 11}" width="13" height="13" fill="${colors[index]}"/><text x="${x + 19}" y="${y}" class="small">${key}</text>`
    );
  });
  return svgFrame(
    width,
    height,
    "Failure taxonomy by protocol",
    lines.join("\n")
  );
}

function main(): void {
  const rows = loadJsonl<ScoredRow>(SCORED);
  mkdirSync(join(OUT_DIR, "charts"), { recursive: true });

  const byArm = groupBy(rows, (row) => row.arm);
  const knownArms = new Set<string>(ARM_ORDER);
  const observedArms: ArmId[] = [
    ...ARM_ORDER.filter((arm) => byArm.has(arm)),
    ...[...byArm.keys()]
      .filter((arm) => !knownArms.has(arm))
      .sort((left, right) => left.localeCompare(right)),
  ];
  const armSummaries = observedArms.map((arm) => {
    const categoryMetrics = CATEGORY_ORDER.map((category) =>
      summarize(
        rows.filter((row) => row.arm === arm && row.category === category)
      )
    );
    return {
      ...summarize(byArm.get(arm) ?? []),
      arm,
      macroAccuracy: mean(
        categoryMetrics.flatMap((metric) =>
          metric.accuracy === null ? [] : [metric.accuracy]
        )
      ),
      macroBfclAccuracy: mean(
        categoryMetrics.flatMap((metric) =>
          metric.bfclAccuracy === null ? [] : [metric.bfclAccuracy]
        )
      ),
    };
  });
  const byCategory = groupBy(rows, (row) => row.category);
  const categorySummaries = CATEGORY_ORDER.map((category) => ({
    ...summarize(byCategory.get(category) ?? []),
    category,
  }));
  const categoryArmMatrix = new Map<string, Summary>();
  for (const category of CATEGORY_ORDER) {
    for (const arm of observedArms) {
      categoryArmMatrix.set(
        `${category}\u0000${arm}`,
        summarize(
          rows.filter((row) => row.category === category && row.arm === arm)
        )
      );
    }
  }

  const failureSummaries = observedArms.map((arm) => {
    const summary: FailureSummary = {
      arm,
      malformed: 0,
      missingCall: 0,
      otherSemantic: 0,
      provider: 0,
      textLeak: 0,
      unexpectedCall: 0,
      wrongCount: 0,
      wrongFunction: 0,
      wrongType: 0,
      wrongValue: 0,
    };
    for (const row of byArm.get(arm) ?? []) {
      const failure = classifyFailure(row);
      if (failure) {
        summary[failure] += 1;
      }
    }
    return summary;
  });

  const paired = summarizePairedVsNative(byArm, observedArms);

  let sensitivity: SensitivitySummary[] | null = null;
  if (SENSITIVITY_SCORED) {
    const sensitivityRows = loadJsonl<ScoredRow>(SENSITIVITY_SCORED);
    sensitivity = (["sijawaraDetailed", "sijawaraConcise"] as const).map(
      (arm) => {
        const original = summarize(byArm.get(arm) ?? []);
        const trimmed = summarize(
          sensitivityRows.filter((row) => row.arm === arm)
        );
        return {
          arm,
          originalAccuracy: original.accuracy ?? 0,
          originalCorrect: original.correct,
          recovered: trimmed.correct - original.correct,
          total: original.total,
          trimmedAccuracy: trimmed.accuracy ?? 0,
          trimmedCorrect: trimmed.correct,
        };
      }
    );
  }

  const summary = {
    arms: armSummaries,
    categories: categorySummaries,
    failureTaxonomy: failureSummaries,
    generatedAt: new Date().toISOString(),
    methodology: {
      conditionalAccuracy:
        "provider-successful rows only; availability and endToEndAccuracy are reported separately",
      pairedPrimary:
        "two-sided exact McNemar on matched end-to-end strict outcomes; provider and parser failures count as incorrect",
      pairedSecondary:
        "conditional strict and BFCL semantic McNemar on pairs where both transports succeeded",
    },
    pairedVsNative: paired,
    sensitivity,
    source: SCORED,
    totalRows: rows.length,
  };
  writeFileSync(
    join(OUT_DIR, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`
  );
  writeFileSync(
    join(OUT_DIR, "protocol-summary.csv"),
    csv(armSummaries as unknown as Record<string, unknown>[])
  );
  writeFileSync(
    join(OUT_DIR, "category-summary.csv"),
    csv(categorySummaries as unknown as Record<string, unknown>[])
  );
  writeFileSync(
    join(OUT_DIR, "failure-summary.csv"),
    csv(failureSummaries as unknown as Record<string, unknown>[])
  );
  writeFileSync(
    join(OUT_DIR, "paired-vs-native.csv"),
    csv(paired as unknown as Record<string, unknown>[])
  );
  writeFileSync(
    join(OUT_DIR, "charts", "accuracy.svg"),
    accuracySvg(
      [...armSummaries].sort(
        (left, right) => (right.accuracy ?? -1) - (left.accuracy ?? -1)
      )
    )
  );
  writeFileSync(
    join(OUT_DIR, "charts", "semantic-vs-strict.svg"),
    semanticVsStrictSvg(armSummaries)
  );
  writeFileSync(
    join(OUT_DIR, "charts", "availability.svg"),
    availabilitySvg(armSummaries)
  );
  writeFileSync(
    join(OUT_DIR, "charts", "latency.svg"),
    latencySvg(armSummaries)
  );
  writeFileSync(join(OUT_DIR, "charts", "tokens.svg"), tokensSvg(armSummaries));
  writeFileSync(
    join(OUT_DIR, "charts", "efficiency.svg"),
    efficiencySvg(armSummaries)
  );
  writeFileSync(
    join(OUT_DIR, "charts", "paired-vs-native.svg"),
    pairedVsNativeSvg(paired)
  );
  writeFileSync(
    join(OUT_DIR, "charts", "category-heatmap.svg"),
    heatmapSvg(categoryArmMatrix, CATEGORY_ORDER, observedArms)
  );
  writeFileSync(
    join(OUT_DIR, "charts", "failures.svg"),
    failureSvg(failureSummaries)
  );
  if (sensitivity) {
    writeFileSync(
      join(OUT_DIR, "sijawara-trim-sensitivity.json"),
      `${JSON.stringify(sensitivity, null, 2)}\n`
    );
    writeFileSync(
      join(OUT_DIR, "charts", "sijawara-trim-sensitivity.svg"),
      sijawaraSensitivitySvg(sensitivity)
    );
  }
  console.log(`Analyzed ${rows.length} rows -> ${OUT_DIR}`);
}

main();
