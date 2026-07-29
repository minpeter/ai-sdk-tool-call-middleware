import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import {
  callsExactlyEqual,
  decodeProductionGlm5Generate,
  decodeProductionGlm5Stream,
  deterministicVariableChunks,
  fixedWidthChunks,
  type Glm5ProductionDecodeResult,
} from "./glm5-parser-evaluation";
import {
  GLM5_REFERENCE_CORPUS,
  GLM5_REFERENCE_CORPUS_TOOLS,
  type Glm5ReferenceCorpusCase,
} from "./glm5-reference-corpus";
import {
  decodeWithGlm5Reference,
  GLM5_REFERENCE_DECODER_SOURCES,
  type Glm5DecodedCall,
  type Glm5ReferenceDecodeResult,
} from "./glm5-reference-decoders";
import type {
  CapturedFunctionTool,
  ProviderCaptureRecord,
} from "./provider-capture";
import { parseCapturedSseChunks } from "./replay-provider-capture-core";

const SOURCE_ARM = "glm5";
const CSV_ESCAPE_PATTERN = /[",\n\r]/u;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const PARSER_ARMS = [
  "vllmReference",
  "sglangReference",
  "productionGenerate",
  "productionStream",
  "vllmPythonReference",
] as const;
const BENCHMARK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_RESULTS_ROOT = join(BENCHMARK_ROOT, "results");
const DEFAULT_BFCL_CAPTURE = join(
  DEFAULT_RESULTS_ROOT,
  "2026-07-17-glm5-native-bfcl-v4-456-generate",
  "provider-raw.jsonl"
);
const DEFAULT_BFCL_RAW = join(
  DEFAULT_RESULTS_ROOT,
  "2026-07-17-glm5-native-bfcl-v4-456-generate",
  "raw.jsonl"
);
const DEFAULT_ACE_CAPTURE = join(
  DEFAULT_RESULTS_ROOT,
  "2026-07-17-glm5-native-ace-normal-100-generate",
  "provider-raw.jsonl"
);
const DEFAULT_ACE_RAW = join(
  DEFAULT_RESULTS_ROOT,
  "2026-07-17-glm5-native-ace-normal-100-generate",
  "raw.jsonl"
);
const DEFAULT_SSE_CAPTURE = join(
  DEFAULT_RESULTS_ROOT,
  "2026-07-17-glm5-native-bfcl-v4-13-sse",
  "provider-raw.jsonl"
);
const DEFAULT_SSE_RAW = join(
  DEFAULT_RESULTS_ROOT,
  "2026-07-17-glm5-native-bfcl-v4-13-sse",
  "raw.jsonl"
);

type NaturalSuite = "ace" | "bfcl";
type NaturalTransport = "generate" | "stream";
type ParserArm = (typeof PARSER_ARMS)[number];

interface SourceRawRow {
  arm: string;
  calls?: unknown;
  caseId: string;
  category: string;
  language?: string;
  nameMap?: Array<{ original: string; safe: string }>;
  rawCaptureIds: string[];
  text?: string;
  transport: NaturalTransport;
  trial: number;
  [key: string]: unknown;
}

interface NaturalInput {
  capturePath: string;
  rawPath: string;
  suite: NaturalSuite;
  transport: NaturalTransport;
}

interface ExtractedCaptureContent {
  chunks: string[];
  errors: string[];
  text: string;
}

interface UnifiedDecodeResult {
  accepted: boolean;
  calls: Glm5DecodedCall[];
  errors: string[];
  parser: ParserArm;
  recoveries: string[];
  text: string;
}

interface NaturalReplayDetail {
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

interface SyntheticParserResult extends UnifiedDecodeResult {
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

export interface ReferenceReplayOptions {
  aceCapture: string;
  aceRaw: string;
  aceRoot?: string;
  bfclCapture: string;
  bfclRaw: string;
  bfclRoot?: string;
  generatedAt?: string;
  outDir: string;
  python: string;
  score: boolean;
  sseCapture: string;
  sseRaw: string;
}

interface ScoredRow extends SourceRawRow {
  protocolValid?: boolean;
  strictCorrect?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function loadJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function writeJsonl(path: string, rows: readonly unknown[]): void {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function contentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((part) => {
      const record = asRecord(part);
      return typeof record?.text === "string" ? record.text : "";
    })
    .join("");
}

function payloadText(payload: unknown, transport: NaturalTransport): string {
  const root = asRecord(payload);
  const choice = Array.isArray(root?.choices)
    ? asRecord(root.choices[0])
    : null;
  const container = asRecord(
    transport === "stream" ? choice?.delta : choice?.message
  );
  return contentText(container?.content);
}

export function extractCapturedCanonicalContent(
  record: ProviderCaptureRecord
): ExtractedCaptureContent {
  const errors: string[] = [];
  const { response } = record;
  if (!response) {
    return { chunks: [], errors: ["Capture has no response."], text: "" };
  }
  if (record.context.transport === "stream") {
    const payloads = parseCapturedSseChunks([response.body], errors);
    const chunks = payloads
      .map((payload) => payloadText(payload, "stream"))
      .filter(Boolean);
    return { chunks, errors, text: chunks.join("") };
  }
  try {
    const payload = JSON.parse(response.body) as unknown;
    const text = payloadText(payload, "generate");
    return { chunks: [text], errors, text };
  } catch (error) {
    errors.push(
      `Malformed captured JSON response: ${error instanceof Error ? error.message : String(error)}`
    );
    return { chunks: [], errors, text: "" };
  }
}

function providerTools(
  tools: readonly CapturedFunctionTool[]
): LanguageModelV4FunctionTool[] {
  return tools.map((tool) => ({
    description: tool.description,
    inputSchema: tool.inputSchema as LanguageModelV4FunctionTool["inputSchema"],
    name: tool.name,
    type: "function",
  }));
}

function withParserName(
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

function originalCalls(
  calls: readonly Glm5DecodedCall[],
  tools: readonly CapturedFunctionTool[]
): Glm5DecodedCall[] {
  const names = new Map(
    tools.map((tool) => [tool.name, tool.originalName ?? tool.name])
  );
  return calls.map((call) => ({
    arguments: call.arguments,
    name: names.get(call.name) ?? call.name,
  }));
}

function hasMarkupLeak(text: string): boolean {
  return ["<tool_call", "</tool_call", "<arg_key", "<arg_value"].some(
    (marker) => text.toLowerCase().includes(marker)
  );
}

function expectedToolAction(suite: NaturalSuite, category: string): boolean {
  return suite === "ace" || !category.includes("irrelevance");
}

function captureForRow(
  row: SourceRawRow,
  captures: ReadonlyMap<string, ProviderCaptureRecord>,
  expected: Pick<NaturalInput, "suite" | "transport">
): ProviderCaptureRecord {
  for (const captureId of [...row.rawCaptureIds].reverse()) {
    const capture = captures.get(captureId);
    if (
      capture?.response &&
      capture.context.arm === SOURCE_ARM &&
      capture.context.suite === expected.suite &&
      capture.context.transport === expected.transport &&
      capture.context.caseId === row.caseId
    ) {
      return capture;
    }
  }
  throw new Error(
    `No linked canonical capture for ${expected.suite}/${expected.transport}/${row.caseId}.`
  );
}

async function productionStreamVariants(
  text: string,
  capturedChunks: readonly string[],
  tools: readonly LanguageModelV4FunctionTool[],
  seed: string
): Promise<{
  capturedOrWhole: Glm5ProductionDecodeResult;
  fixedOne: Glm5ProductionDecodeResult;
  fixedSeven: Glm5ProductionDecodeResult;
  seeded: Glm5ProductionDecodeResult;
}> {
  return {
    capturedOrWhole: await decodeProductionGlm5Stream(
      capturedChunks.length > 0 ? capturedChunks : [text],
      tools
    ),
    fixedOne: await decodeProductionGlm5Stream(
      fixedWidthChunks(text, 1),
      tools
    ),
    fixedSeven: await decodeProductionGlm5Stream(
      fixedWidthChunks(text, 7),
      tools
    ),
    seeded: await decodeProductionGlm5Stream(
      deterministicVariableChunks(text, seed),
      tools
    ),
  };
}

function parity(
  generate: Glm5ProductionDecodeResult,
  stream: Glm5ProductionDecodeResult
): boolean {
  return (
    callsExactlyEqual(generate.calls, stream.calls) &&
    generate.text === stream.text
  );
}

function rawReplayRow(
  source: SourceRawRow,
  capture: ProviderCaptureRecord,
  parser: ParserArm,
  result: UnifiedDecodeResult
): SourceRawRow {
  const calls = originalCalls(result.calls, capture.context.tools);
  return {
    ...source,
    arm: parser,
    calls,
    offlineParserReplay: {
      captureId: capture.captureId,
      contentSha256: sha256(extractCapturedCanonicalContent(capture).text),
      parser,
      sourceArm: SOURCE_ARM,
    },
    parserErrors: result.errors,
    parserRecoveries: result.recoveries,
    rawCaptureIds: [capture.captureId],
    text: result.text.slice(0, 4000),
    textLeak: hasMarkupLeak(result.text),
    transportOk: true,
  };
}

async function replayNaturalInput(input: NaturalInput): Promise<{
  details: NaturalReplayDetail[];
  rawRows: SourceRawRow[];
}> {
  const captures = new Map(
    loadJsonl<ProviderCaptureRecord>(input.capturePath).map((record) => [
      record.captureId,
      record,
    ])
  );
  const sourceRows = loadJsonl<SourceRawRow>(input.rawPath).filter(
    (row) => row.arm === SOURCE_ARM
  );
  const details: NaturalReplayDetail[] = [];
  const rawRows: SourceRawRow[] = [];
  for (const source of sourceRows) {
    const capture = captureForRow(source, captures, input);
    const extracted = extractCapturedCanonicalContent(capture);
    if (extracted.errors.length > 0) {
      throw new Error(
        `Capture extraction failed for ${source.caseId}: ${extracted.errors.join("; ")}`
      );
    }
    const tools = providerTools(capture.context.tools);
    const productionGenerate = decodeProductionGlm5Generate(
      extracted.text,
      tools
    );
    const streams = await productionStreamVariants(
      extracted.text,
      input.transport === "stream" ? extracted.chunks : [extracted.text],
      tools,
      `${input.suite}\0${input.transport}\0${source.caseId}`
    );
    const results: Record<ParserArm, UnifiedDecodeResult> = {
      productionGenerate: withParserName(
        "productionGenerate",
        productionGenerate
      ),
      productionStream: withParserName(
        "productionStream",
        streams.capturedOrWhole
      ),
      sglangReference: withParserName(
        "sglangReference",
        decodeWithGlm5Reference("sglang", extracted.text, tools)
      ),
      vllmReference: withParserName(
        "vllmReference",
        decodeWithGlm5Reference("vllm", extracted.text, tools)
      ),
      vllmPythonReference: withParserName(
        "vllmPythonReference",
        decodeWithGlm5Reference("vllm-python", extracted.text, tools)
      ),
    };
    const actionExpected = expectedToolAction(input.suite, source.category);
    const parserResults = Object.fromEntries(
      PARSER_ARMS.map((parser) => {
        const result = results[parser];
        return [
          parser,
          {
            ...result,
            exactVsProductionGenerate: callsExactlyEqual(
              result.calls,
              productionGenerate.calls
            ),
            falsePositive: !actionExpected && result.calls.length > 0,
          },
        ];
      })
    ) as NaturalReplayDetail["parserResults"];
    const parityByStrategy = {
      capturedOrWholeVsGenerate: parity(
        productionGenerate,
        streams.capturedOrWhole
      ),
      fixedOneVsGenerate: parity(productionGenerate, streams.fixedOne),
      fixedSevenVsGenerate: parity(productionGenerate, streams.fixedSeven),
      seededVsGenerate: parity(productionGenerate, streams.seeded),
    };
    details.push({
      captureId: capture.captureId,
      caseId: source.caseId,
      category: source.category,
      contentSha256: sha256(extracted.text),
      corpus: "natural-canonical-capture",
      expectedToolAction: actionExpected,
      language: source.language,
      parserResults,
      productionParity: {
        ...parityByStrategy,
        allChunkStrategiesInvariant:
          Object.values(parityByStrategy).every(Boolean),
      },
      responseSha256: sha256(capture.response?.body ?? ""),
      suite: input.suite,
      transport: input.transport,
      trial: source.trial,
    });
    for (const parser of PARSER_ARMS) {
      rawRows.push(rawReplayRow(source, capture, parser, results[parser]));
    }
  }
  return { details, rawRows };
}

function syntheticResult(
  parser: ParserArm,
  result: Glm5ReferenceDecodeResult | Glm5ProductionDecodeResult,
  expectedCalls: readonly Glm5DecodedCall[]
): SyntheticParserResult {
  const normalized = withParserName(parser, result);
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

export async function evaluateSyntheticCorpusCase(
  testCase: Glm5ReferenceCorpusCase
): Promise<SyntheticReplayDetail> {
  const generate = decodeProductionGlm5Generate(
    testCase.text,
    GLM5_REFERENCE_CORPUS_TOOLS
  );
  const streams = await productionStreamVariants(
    testCase.text,
    [testCase.text],
    GLM5_REFERENCE_CORPUS_TOOLS,
    `synthetic\0${testCase.id}`
  );
  const parserResults: SyntheticReplayDetail["parserResults"] = {
    productionGenerate: syntheticResult(
      "productionGenerate",
      generate,
      testCase.expectedCalls
    ),
    productionStream: syntheticResult(
      "productionStream",
      streams.capturedOrWhole,
      testCase.expectedCalls
    ),
    sglangReference: syntheticResult(
      "sglangReference",
      decodeWithGlm5Reference(
        "sglang",
        testCase.text,
        GLM5_REFERENCE_CORPUS_TOOLS
      ),
      testCase.expectedCalls
    ),
    vllmReference: syntheticResult(
      "vllmReference",
      decodeWithGlm5Reference(
        "vllm",
        testCase.text,
        GLM5_REFERENCE_CORPUS_TOOLS
      ),
      testCase.expectedCalls
    ),
    vllmPythonReference: syntheticResult(
      "vllmPythonReference",
      decodeWithGlm5Reference(
        "vllm-python",
        testCase.text,
        GLM5_REFERENCE_CORPUS_TOOLS
      ),
      testCase.expectedCalls
    ),
  };
  const parityByStrategy = {
    fixedOneVsGenerate: parity(generate, streams.fixedOne),
    fixedSevenVsGenerate: parity(generate, streams.fixedSeven),
    seededVsGenerate: parity(generate, streams.seeded),
    wholeVsGenerate: parity(generate, streams.capturedOrWhole),
  };
  return {
    caseId: testCase.id,
    corpus: "synthetic-official-template-derived",
    expectedCalls: testCase.expectedCalls,
    family: testCase.family,
    note: testCase.note,
    parserResults,
    productionParity: {
      ...parityByStrategy,
      allChunkStrategiesInvariant:
        Object.values(parityByStrategy).every(Boolean),
    },
    text: testCase.text,
  };
}

async function evaluateSyntheticCorpus(): Promise<SyntheticReplayDetail[]> {
  const output: SyntheticReplayDetail[] = [];
  for (const testCase of GLM5_REFERENCE_CORPUS) {
    output.push(await evaluateSyntheticCorpusCase(testCase));
  }
  return output;
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return CSV_ESCAPE_PATTERN.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

function toCsv(headers: readonly string[], rows: readonly unknown[][]): string {
  return `${[
    headers.map(csvCell).join(","),
    ...rows.map((row) => row.map(csvCell).join(",")),
  ].join("\n")}\n`;
}

function syntheticSummary(details: readonly SyntheticReplayDetail[]) {
  return Object.fromEntries(
    PARSER_ARMS.map((parser) => {
      const rows = details.map((detail) => detail.parserResults[parser]);
      const exactTruePositive = rows.filter(
        (row, index) => details[index]?.expectedCalls.length && row.exact
      ).length;
      const falsePositive = rows.filter((row) => row.falsePositive).length;
      const expectedPositive = details.filter(
        (detail) => detail.expectedCalls.length > 0
      ).length;
      return [
        parser,
        {
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
        },
      ];
    })
  );
}

function scoreRawFile(options: {
  aceRoot?: string;
  bfclRoot?: string;
  out: string;
  python: string;
  raw: string;
  suite: NaturalSuite;
}): void {
  const script = join(
    BENCHMARK_ROOT,
    options.suite === "bfcl" ? "score_bfcl.py" : "score_ace.py"
  );
  const root = options.suite === "bfcl" ? options.bfclRoot : options.aceRoot;
  if (!root) {
    throw new Error(`Missing ${options.suite} root for strict scoring.`);
  }
  const rootFlag = options.suite === "bfcl" ? "--bfcl-root" : "--ace-root";
  execFileSync(
    options.python,
    [script, "--raw", options.raw, "--out", options.out, rootFlag, root],
    { encoding: "utf8", stdio: "pipe" }
  );
}

function strictSummary(scoredRows: readonly ScoredRow[]) {
  const byParser = Object.fromEntries(
    PARSER_ARMS.map((parser) => {
      const rows = scoredRows.filter((row) => row.arm === parser);
      const correct = rows.filter((row) => row.strictCorrect).length;
      return [
        parser,
        {
          accuracy: rows.length === 0 ? null : correct / rows.length,
          correct,
          protocolValid: rows.filter((row) => row.protocolValid).length,
          total: rows.length,
        },
      ];
    })
  );
  const baselineRows = new Map(
    scoredRows
      .filter((row) => row.arm === "productionGenerate")
      .map((row) => [
        `${row.language ?? ""}\0${row.category}\0${row.caseId}\0${row.trial}`,
        Boolean(row.strictCorrect),
      ])
  );
  const pairwiseVsProductionGenerate = Object.fromEntries(
    PARSER_ARMS.filter((parser) => parser !== "productionGenerate").map(
      (parser) => {
        let wins = 0;
        let losses = 0;
        let ties = 0;
        for (const row of scoredRows.filter((item) => item.arm === parser)) {
          const baseline = baselineRows.get(
            `${row.language ?? ""}\0${row.category}\0${row.caseId}\0${row.trial}`
          );
          if (
            baseline === undefined ||
            baseline === Boolean(row.strictCorrect)
          ) {
            ties += 1;
          } else if (row.strictCorrect) {
            wins += 1;
          } else {
            losses += 1;
          }
        }
        return [parser, { losses, ties, wins }];
      }
    )
  );
  return { byParser, pairwiseVsProductionGenerate };
}

function naturalAcceptanceSummary(details: readonly NaturalReplayDetail[]) {
  return Object.fromEntries(
    PARSER_ARMS.map((parser) => {
      const rows = details.map((detail) => detail.parserResults[parser]);
      return [
        parser,
        {
          accepted: rows.filter((row) => row.accepted).length,
          exactVsProductionGenerate: rows.filter(
            (row) => row.exactVsProductionGenerate
          ).length,
          falsePositive: rows.filter((row) => row.falsePositive).length,
          parserErrorRows: rows.filter((row) => row.errors.length > 0).length,
          parserRecoveryRows: rows.filter((row) => row.recoveries.length > 0)
            .length,
          total: rows.length,
        },
      ];
    })
  );
}

export async function runReferenceParserReplay(
  options: ReferenceReplayOptions
): Promise<Record<string, unknown>> {
  mkdirSync(options.outDir, { recursive: true });
  const inputs: NaturalInput[] = [
    {
      capturePath: options.bfclCapture,
      rawPath: options.bfclRaw,
      suite: "bfcl",
      transport: "generate",
    },
    {
      capturePath: options.aceCapture,
      rawPath: options.aceRaw,
      suite: "ace",
      transport: "generate",
    },
    {
      capturePath: options.sseCapture,
      rawPath: options.sseRaw,
      suite: "bfcl",
      transport: "stream",
    },
  ];
  const naturalSections: Record<string, unknown> = {};
  const allNaturalDetails: NaturalReplayDetail[] = [];
  for (const input of inputs) {
    for (const path of [input.capturePath, input.rawPath]) {
      if (!existsSync(path)) {
        throw new Error(
          `Required natural replay input does not exist: ${path}`
        );
      }
    }
    const replay = await replayNaturalInput(input);
    const stem = `natural-${input.suite}-${input.transport}`;
    const rawPath = join(options.outDir, `${stem}.raw.jsonl`);
    const detailPath = join(options.outDir, `${stem}.details.jsonl`);
    writeJsonl(rawPath, replay.rawRows);
    writeJsonl(detailPath, replay.details);
    allNaturalDetails.push(...replay.details);
    const section: Record<string, unknown> = {
      acceptance: naturalAcceptanceSummary(replay.details),
      cases: replay.details.length,
      detailPath,
      rawPath,
    };
    if (options.score) {
      const scoredPath = join(options.outDir, `${stem}.scored.jsonl`);
      scoreRawFile({
        aceRoot: options.aceRoot,
        bfclRoot: options.bfclRoot,
        out: scoredPath,
        python: options.python,
        raw: rawPath,
        suite: input.suite,
      });
      const scoredRows = loadJsonl<ScoredRow>(scoredPath);
      section.scoredPath = scoredPath;
      section.strict = strictSummary(scoredRows);
    }
    naturalSections[`${input.suite}-${input.transport}`] = section;
  }

  const syntheticDetails = await evaluateSyntheticCorpus();
  const syntheticMetrics = syntheticSummary(syntheticDetails);
  writeJsonl(join(options.outDir, "synthetic-corpus.jsonl"), syntheticDetails);
  writeFileSync(
    join(options.outDir, "synthetic-parser-summary.csv"),
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
        const metric = syntheticMetrics[parser] as Record<string, unknown>;
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
    join(options.outDir, "natural-parser-summary.csv"),
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
      Object.entries(naturalSections).flatMap(([sectionName, section]) => {
        const [suite, transport] = sectionName.split("-");
        const { acceptance, strict } = section as {
          acceptance: Record<string, unknown>;
          strict?: {
            byParser: Record<string, Record<string, unknown>>;
          };
        };
        return PARSER_ARMS.map((parser) => {
          const metric = acceptance[parser] as Record<string, unknown>;
          const strictMetric = strict?.byParser[parser];
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
            strictMetric?.correct ?? "",
            strictMetric?.total ?? "",
            strictMetric?.accuracy ?? "",
            strictMetric?.protocolValid ?? "",
          ];
        });
      })
    )
  );
  writeFileSync(
    join(options.outDir, "natural-pairwise-summary.csv"),
    toCsv(
      ["suite", "transport", "candidate", "baseline", "wins", "losses", "ties"],
      Object.entries(naturalSections).flatMap(([sectionName, section]) => {
        const [suite, transport] = sectionName.split("-");
        const { strict } = section as {
          strict?: {
            pairwiseVsProductionGenerate: Record<
              string,
              Record<string, unknown>
            >;
          };
        };
        if (!strict) {
          return [];
        }
        return Object.entries(strict.pairwiseVsProductionGenerate).map(
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
      })
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
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    natural: naturalSections,
    naturalProductionChunkInvariant: allNaturalDetails.filter(
      (detail) => detail.productionParity.allChunkStrategiesInvariant
    ).length,
    naturalTotal: allNaturalDetails.length,
    providerCalls: 0,
    referenceSources: GLM5_REFERENCE_DECODER_SOURCES,
    synthetic: {
      cases: syntheticDetails.length,
      corpus: "official-template-derived-labeled-conformance-and-corruption",
      metrics: syntheticMetrics,
      productionChunkInvariant: syntheticDetails.filter(
        (detail) => detail.productionParity.allChunkStrategiesInvariant
      ).length,
    },
  };
  writeFileSync(
    join(options.outDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`
  );
  return summary;
}

function argumentValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function normalizedGeneratedAt(args: string[]): string | undefined {
  const value = argumentValue(args, "--generated-at");
  if (!args.includes("--generated-at")) {
    return;
  }
  const timestamp = value ? Date.parse(value) : Number.NaN;
  if (
    !(value && ISO_TIMESTAMP_PATTERN.test(value)) ||
    Number.isNaN(timestamp)
  ) {
    throw new Error(
      "--generated-at must be a valid ISO-8601 timestamp with a timezone."
    );
  }
  return new Date(timestamp).toISOString();
}

export function optionsFromArgv(args: string[]): ReferenceReplayOptions {
  const outDir = resolve(
    argumentValue(args, "--out-dir") ??
      join(DEFAULT_RESULTS_ROOT, "2026-07-17-glm5-reference-parser-replay-v1")
  );
  const generatedAt = normalizedGeneratedAt(args);
  return {
    aceCapture: resolve(
      argumentValue(args, "--ace-capture") ?? DEFAULT_ACE_CAPTURE
    ),
    aceRaw: resolve(argumentValue(args, "--ace-raw") ?? DEFAULT_ACE_RAW),
    aceRoot: resolve(
      argumentValue(args, "--ace-root") ?? "/tmp/acebench-function-calling"
    ),
    bfclCapture: resolve(
      argumentValue(args, "--bfcl-capture") ?? DEFAULT_BFCL_CAPTURE
    ),
    bfclRaw: resolve(argumentValue(args, "--bfcl-raw") ?? DEFAULT_BFCL_RAW),
    bfclRoot: resolve(
      argumentValue(args, "--bfcl-root") ??
        "/tmp/bfcl-research/berkeley-function-call-leaderboard"
    ),
    ...(generatedAt ? { generatedAt } : {}),
    outDir,
    python: argumentValue(args, "--python") ?? "python3",
    score: !args.includes("--skip-score"),
    sseCapture: resolve(
      argumentValue(args, "--sse-capture") ?? DEFAULT_SSE_CAPTURE
    ),
    sseRaw: resolve(argumentValue(args, "--sse-raw") ?? DEFAULT_SSE_RAW),
  };
}

async function main(): Promise<void> {
  const options = optionsFromArgv(process.argv.slice(2));
  const summary = await runReferenceParserReplay(options);
  process.stdout.write(
    `${JSON.stringify({ outDir: options.outDir, summary }, null, 2)}\n`
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
