import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeAnalysisOutputs } from "#benchmark/analyze-output";

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
const FUNCTION_ERROR_PATTERN = /wrong_func_name/;
const MISSING_CALL_PATTERN = /relevance:missing_call/;
const TYPE_ERROR_PATTERN = /type_error/;
const UNEXPECTED_CALL_PATTERN = /irrelevance:unexpected_call/;
const VALUE_ERROR_PATTERN = /value_error/;
const WRONG_COUNT_PATTERN = /wrong_count/;
const WRONG_NUMBER_PATTERN = /Wrong number/;

export type ArmId = string;
export type Category = (typeof CATEGORY_ORDER)[number];

export interface Summary {
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

export interface FailureSummary {
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

export interface PairedSummary {
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

export interface SensitivitySummary {
  arm: "sijawaraDetailed" | "sijawaraConcise";
  originalAccuracy: number;
  originalCorrect: number;
  recovered: number;
  total: number;
  trimmedAccuracy: number;
  trimmedCorrect: number;
}

export interface AnalysisOutput {
  readonly armSummaries: Array<
    Summary & {
      arm: ArmId;
      macroAccuracy: number | null;
      macroBfclAccuracy: number | null;
    }
  >;
  readonly categories: readonly Category[];
  readonly categoryArmMatrix: Map<string, Summary>;
  readonly categorySummaries: Array<Summary & { category: Category }>;
  readonly failureSummaries: FailureSummary[];
  readonly observedArms: ArmId[];
  readonly outDir: string;
  readonly paired: PairedSummary[];
  readonly sensitivity: SensitivitySummary[] | null;
  readonly source: string;
  readonly totalRows: number;
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

function main(): void {
  const rows = loadJsonl<ScoredRow>(SCORED);
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

  writeAnalysisOutputs({
    armSummaries,
    categories: CATEGORY_ORDER,
    categoryArmMatrix,
    categorySummaries,
    failureSummaries,
    observedArms,
    outDir: OUT_DIR,
    paired,
    sensitivity,
    source: SCORED,
    totalRows: rows.length,
  });
  console.log(`Analyzed ${rows.length} rows -> ${OUT_DIR}`);
}

main();
