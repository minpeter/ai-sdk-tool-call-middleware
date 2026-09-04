import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  callsExactlyEqual,
  type Glm5ProductionDecodeResult,
} from "./glm5-parser-evaluation";
import type {
  Glm5DecodedCall,
  Glm5ReferenceDecodeResult,
} from "./glm5-reference-decoders";
import { GLM5_REFERENCE_DECODER_SOURCES } from "./glm5-reference-decoders";

const CSV_ESCAPE_PATTERN = /[",\n\r]/u;

export const PARSER_ARMS = [
  "vllmReference",
  "sglangReference",
  "productionGenerate",
  "productionStream",
  "vllmPythonReference",
] as const;

export type NaturalSuite = "ace" | "bfcl";
export type NaturalTransport = "generate" | "stream";
export type ParserArm = (typeof PARSER_ARMS)[number];

export interface UnifiedDecodeResult {
  accepted: boolean;
  calls: Glm5DecodedCall[];
  errors: string[];
  parser: ParserArm;
  recoveries: string[];
  text: string;
}

export interface NaturalReplayDetail {
  captureId: string;
  caseId: string;
  category: string;
  contentSha256: string;
  corpus: "natural-canonical-capture";
  expectedToolAction: boolean;
  language?: string;
  parserResults: Record<
    ParserArm,
    UnifiedDecodeResult & {
      exactVsProductionGenerate: boolean;
      falsePositive: boolean;
    }
  >;
  productionParity: {
    allChunkStrategiesInvariant: boolean;
    capturedOrWholeVsGenerate: boolean;
    fixedOneVsGenerate: boolean;
    fixedSevenVsGenerate: boolean;
    seededVsGenerate: boolean;
  };
  responseSha256: string;
  suite: NaturalSuite;
  transport: NaturalTransport;
  trial: number;
}

export interface SyntheticParserResult extends UnifiedDecodeResult {
  actionCorrect: boolean;
  exact: boolean;
  falseNegative: boolean;
  falsePositive: boolean;
}

export interface SyntheticReplayDetail {
  caseId: string;
  corpus: "synthetic-official-template-derived";
  expectedCalls: Glm5DecodedCall[];
  family: string;
  note: string;
  parserResults: Record<ParserArm, SyntheticParserResult>;
  productionParity: {
    allChunkStrategiesInvariant: boolean;
    fixedOneVsGenerate: boolean;
    fixedSevenVsGenerate: boolean;
    seededVsGenerate: boolean;
    wholeVsGenerate: boolean;
  };
  text: string;
}

export function normalizeDecodeResult(
  parser: ParserArm,
  result: Glm5ReferenceDecodeResult | Glm5ProductionDecodeResult
): UnifiedDecodeResult {
  return {
    accepted: result.accepted,
    calls: result.calls,
    errors: result.errors,
    parser,
    recoveries: "recoveries" in result ? result.recoveries : [],
    text: result.text,
  };
}

export function evaluateSyntheticResult(
  parser: ParserArm,
  result: Glm5ReferenceDecodeResult | Glm5ProductionDecodeResult,
  expectedCalls: readonly Glm5DecodedCall[]
): SyntheticParserResult {
  const normalized = normalizeDecodeResult(parser, result);
  const expectedAction = expectedCalls.length > 0;
  const exact = callsExactlyEqual(normalized.calls, expectedCalls);
  return {
    ...normalized,
    actionCorrect: normalized.accepted === expectedAction,
    exact,
    falseNegative: expectedAction && !exact,
    falsePositive: normalized.accepted && !exact,
  };
}

export interface ScoredReplayRow {
  arm: string;
  caseId: string;
  category: string;
  language?: string;
  protocolValid?: boolean;
  strictCorrect?: boolean;
  trial: number;
}

interface SyntheticMetric {
  actionCorrect: number;
  exactCorrect: number;
  exactPrecision: number;
  exactRecall: number;
  falseNegative: number;
  falsePositive: number;
  total: number;
}

interface NaturalAcceptanceMetric {
  accepted: number;
  exactVsProductionGenerate: number;
  falsePositive: number;
  parserErrorRows: number;
  parserRecoveryRows: number;
  total: number;
}

interface StrictMetric {
  accuracy: number | null;
  correct: number;
  protocolValid: number;
  total: number;
}

interface PairwiseMetric {
  losses: number;
  ties: number;
  wins: number;
}

export interface StrictSummary {
  byParser: Record<ParserArm, StrictMetric>;
  pairwiseVsProductionGenerate: Record<
    Exclude<ParserArm, "productionGenerate">,
    PairwiseMetric
  >;
}

export interface NaturalReplaySection {
  acceptance: Record<ParserArm, NaturalAcceptanceMetric>;
  cases: number;
  detailPath: string;
  rawPath: string;
  scoredPath?: string;
  strict?: StrictSummary;
}

interface NaturalArtifactInput {
  details: readonly NaturalReplayDetail[];
  outDir: string;
  rawRows: readonly object[];
  stem: string;
}

interface NaturalArtifactPaths {
  detailPath: string;
  rawPath: string;
}

interface ReplayReportInput {
  allNaturalDetails: readonly NaturalReplayDetail[];
  generatedAt?: string;
  naturalSections: Readonly<Record<string, NaturalReplaySection>>;
  outDir: string;
  syntheticDetails: readonly SyntheticReplayDetail[];
}

function writeJsonl(path: string, rows: readonly object[]): void {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

export function writeNaturalReplayArtifacts(
  input: NaturalArtifactInput
): NaturalArtifactPaths {
  const rawPath = join(input.outDir, `${input.stem}.raw.jsonl`);
  const detailPath = join(input.outDir, `${input.stem}.details.jsonl`);
  writeJsonl(rawPath, input.rawRows);
  writeJsonl(detailPath, input.details);
  return { detailPath, rawPath };
}

function csvCell(value: string | number | null): string {
  const text = String(value ?? "");
  return CSV_ESCAPE_PATTERN.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

function toCsv(
  headers: readonly string[],
  rows: readonly (readonly (string | number | null)[])[]
): string {
  return `${[
    headers.map(csvCell).join(","),
    ...rows.map((row) => row.map(csvCell).join(",")),
  ].join("\n")}\n`;
}

function syntheticMetric(
  details: readonly SyntheticReplayDetail[],
  parser: ParserArm
): SyntheticMetric {
  const rows = details.map((detail) => detail.parserResults[parser]);
  const exactTruePositive = rows.filter(
    (row, index) => details[index]?.expectedCalls.length && row.exact
  ).length;
  const falsePositive = rows.filter((row) => row.falsePositive).length;
  const expectedPositive = details.filter(
    (detail) => detail.expectedCalls.length > 0
  ).length;
  return {
    actionCorrect: rows.filter((row) => row.actionCorrect).length,
    exactCorrect: rows.filter((row) => row.exact).length,
    exactPrecision:
      exactTruePositive + falsePositive === 0
        ? 1
        : exactTruePositive / (exactTruePositive + falsePositive),
    exactRecall:
      expectedPositive === 0 ? 1 : exactTruePositive / expectedPositive,
    falseNegative: rows.filter((row) => row.falseNegative).length,
    falsePositive,
    total: rows.length,
  };
}

function syntheticSummary(
  details: readonly SyntheticReplayDetail[]
): Record<ParserArm, SyntheticMetric> {
  return {
    vllmReference: syntheticMetric(details, "vllmReference"),
    sglangReference: syntheticMetric(details, "sglangReference"),
    productionGenerate: syntheticMetric(details, "productionGenerate"),
    productionStream: syntheticMetric(details, "productionStream"),
    vllmPythonReference: syntheticMetric(details, "vllmPythonReference"),
  };
}

function strictMetric(
  scoredRows: readonly ScoredReplayRow[],
  parser: ParserArm
): StrictMetric {
  const rows = scoredRows.filter((row) => row.arm === parser);
  const correct = rows.filter((row) => row.strictCorrect).length;
  return {
    accuracy: rows.length === 0 ? null : correct / rows.length,
    correct,
    protocolValid: rows.filter((row) => row.protocolValid).length,
    total: rows.length,
  };
}

function pairwiseMetric(
  scoredRows: readonly ScoredReplayRow[],
  baselineRows: ReadonlyMap<string, boolean>,
  parser: Exclude<ParserArm, "productionGenerate">
): PairwiseMetric {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const row of scoredRows.filter((item) => item.arm === parser)) {
    const baseline = baselineRows.get(
      `${row.language ?? ""}\0${row.category}\0${row.caseId}\0${row.trial}`
    );
    if (baseline === undefined || baseline === Boolean(row.strictCorrect)) {
      ties += 1;
    } else if (row.strictCorrect) {
      wins += 1;
    } else {
      losses += 1;
    }
  }
  return { losses, ties, wins };
}

export function strictSummary(
  scoredRows: readonly ScoredReplayRow[]
): StrictSummary {
  const baselineRows = new Map(
    scoredRows
      .filter((row) => row.arm === "productionGenerate")
      .map((row) => [
        `${row.language ?? ""}\0${row.category}\0${row.caseId}\0${row.trial}`,
        Boolean(row.strictCorrect),
      ])
  );
  return {
    byParser: {
      vllmReference: strictMetric(scoredRows, "vllmReference"),
      sglangReference: strictMetric(scoredRows, "sglangReference"),
      productionGenerate: strictMetric(scoredRows, "productionGenerate"),
      productionStream: strictMetric(scoredRows, "productionStream"),
      vllmPythonReference: strictMetric(scoredRows, "vllmPythonReference"),
    },
    pairwiseVsProductionGenerate: {
      vllmReference: pairwiseMetric(scoredRows, baselineRows, "vllmReference"),
      sglangReference: pairwiseMetric(
        scoredRows,
        baselineRows,
        "sglangReference"
      ),
      productionStream: pairwiseMetric(
        scoredRows,
        baselineRows,
        "productionStream"
      ),
      vllmPythonReference: pairwiseMetric(
        scoredRows,
        baselineRows,
        "vllmPythonReference"
      ),
    },
  };
}

function naturalAcceptanceMetric(
  details: readonly NaturalReplayDetail[],
  parser: ParserArm
): NaturalAcceptanceMetric {
  const rows = details.map((detail) => detail.parserResults[parser]);
  return {
    accepted: rows.filter((row) => row.accepted).length,
    exactVsProductionGenerate: rows.filter(
      (row) => row.exactVsProductionGenerate
    ).length,
    falsePositive: rows.filter((row) => row.falsePositive).length,
    parserErrorRows: rows.filter((row) => row.errors.length > 0).length,
    parserRecoveryRows: rows.filter((row) => row.recoveries.length > 0).length,
    total: rows.length,
  };
}

export function naturalAcceptanceSummary(
  details: readonly NaturalReplayDetail[]
): Record<ParserArm, NaturalAcceptanceMetric> {
  return {
    vllmReference: naturalAcceptanceMetric(details, "vllmReference"),
    sglangReference: naturalAcceptanceMetric(details, "sglangReference"),
    productionGenerate: naturalAcceptanceMetric(details, "productionGenerate"),
    productionStream: naturalAcceptanceMetric(details, "productionStream"),
    vllmPythonReference: naturalAcceptanceMetric(
      details,
      "vllmPythonReference"
    ),
  };
}

function naturalSummaryRows(
  naturalSections: Readonly<Record<string, NaturalReplaySection>>
): readonly (readonly (string | number | null)[])[] {
  return Object.entries(naturalSections).flatMap(([sectionName, section]) => {
    const [suite = "", transport = ""] = sectionName.split("-");
    return PARSER_ARMS.map((parser) => {
      const metric = section.acceptance[parser];
      const strictMetricForParser = section.strict?.byParser[parser];
      return [
        suite,
        transport,
        parser,
        metric.total,
        metric.accepted,
        metric.exactVsProductionGenerate,
        metric.falsePositive,
        metric.parserErrorRows,
        metric.parserRecoveryRows,
        strictMetricForParser?.correct ?? "",
        strictMetricForParser?.total ?? "",
        strictMetricForParser?.accuracy ?? "",
        strictMetricForParser?.protocolValid ?? "",
      ];
    });
  });
}

function pairwiseSummaryRows(
  naturalSections: Readonly<Record<string, NaturalReplaySection>>
): readonly (readonly (string | number)[])[] {
  return Object.entries(naturalSections).flatMap(([sectionName, section]) => {
    const [suite = "", transport = ""] = sectionName.split("-");
    if (!section.strict) {
      return [];
    }
    return Object.entries(section.strict.pairwiseVsProductionGenerate).map(
      ([candidate, metric]) => [
        suite,
        transport,
        candidate,
        "productionGenerate",
        metric.wins,
        metric.losses,
        metric.ties,
      ]
    );
  });
}

export function writeReferenceReplayReports(
  input: ReplayReportInput
): Record<string, unknown> {
  const syntheticMetrics = syntheticSummary(input.syntheticDetails);
  writeJsonl(
    join(input.outDir, "synthetic-corpus.jsonl"),
    input.syntheticDetails
  );
  writeFileSync(
    join(input.outDir, "synthetic-parser-summary.csv"),
    toCsv(
      [
        "parser",
        "total",
        "action_correct",
        "exact_correct",
        "false_positive",
        "false_negative",
        "exact_precision",
        "exact_recall",
      ],
      PARSER_ARMS.map((parser) => {
        const metric = syntheticMetrics[parser];
        return [
          parser,
          metric.total,
          metric.actionCorrect,
          metric.exactCorrect,
          metric.falsePositive,
          metric.falseNegative,
          metric.exactPrecision,
          metric.exactRecall,
        ];
      })
    )
  );
  writeFileSync(
    join(input.outDir, "natural-parser-summary.csv"),
    toCsv(
      [
        "suite",
        "transport",
        "parser",
        "total",
        "accepted",
        "exact_vs_production_generate",
        "false_positive",
        "parser_error_rows",
        "parser_recovery_rows",
        "strict_correct",
        "strict_total",
        "strict_accuracy",
        "protocol_valid",
      ],
      naturalSummaryRows(input.naturalSections)
    )
  );
  writeFileSync(
    join(input.outDir, "natural-pairwise-summary.csv"),
    toCsv(
      ["suite", "transport", "candidate", "baseline", "wins", "losses", "ties"],
      pairwiseSummaryRows(input.naturalSections)
    )
  );

  const summary = {
    artifactVersion: 1,
    caveat:
      "vLLM and SGLang are pinned deployment-reference reproductions; this does not identify the FreeRouter backend parser.",
    diagnosticPolicy: {
      fatal:
        "Decoder failures and invalid finalized JSON are written to parserErrors and invalidate protocol-strict scoring.",
      recovery:
        "Successful `Recovered malformed...` callbacks are preserved in parserRecoveries and do not invalidate an otherwise oracle-correct call.",
    },
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    natural: input.naturalSections,
    naturalProductionChunkInvariant: input.allNaturalDetails.filter(
      (detail) => detail.productionParity.allChunkStrategiesInvariant
    ).length,
    naturalTotal: input.allNaturalDetails.length,
    providerCalls: 0,
    referenceSources: GLM5_REFERENCE_DECODER_SOURCES,
    synthetic: {
      cases: input.syntheticDetails.length,
      corpus: "official-template-derived-labeled-conformance-and-corruption",
      metrics: syntheticMetrics,
      productionChunkInvariant: input.syntheticDetails.filter(
        (detail) => detail.productionParity.allChunkStrategiesInvariant
      ).length,
    },
  };
  writeFileSync(
    join(input.outDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`
  );
  return summary;
}
