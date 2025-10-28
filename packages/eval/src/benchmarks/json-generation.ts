import { promises as fs } from "node:fs";
import path from "node:path";
import { generateText, type LanguageModel } from "ai";
import Ajv, { type AnySchema } from "ajv";

import type { BenchmarkResult, LanguageModelV2Benchmark } from "@/interfaces";
import { resolveDataDir } from "@/utils/paths";

type Json = unknown;

// Regex patterns used for JSON extraction
const JSON_FENCE_REGEX = /```json\s*([\s\S]*?)```/i;
const CODE_FENCE_REGEX = /```\s*([\s\S]*?)```/i;
const NEWLINE_REGEX = /\r?\n/;
const LINE_SPLIT_REGEX = /\r?\n/;

type SchemaTestCase = {
  id: string;
  description: string;
  schema: AnySchema; // JSON Schema (draft 2020-12 subset supported by Ajv v8)
  promptFacts: string; // natural language facts to express desired values
  expected: Json; // subset of fields we expect to match exactly
};

type ExpectedRecord = {
  id: string;
  expected: Json;
};

function tryDirectParse(text: string): Json | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return;
  }
}

function tryCodeFenceParse(text: string): Json | undefined {
  const fenceMatch =
    text.match(JSON_FENCE_REGEX) || text.match(CODE_FENCE_REGEX);
  if (!fenceMatch) {
    return;
  }

  const inner = fenceMatch[1].trim();
  try {
    return JSON.parse(inner);
  } catch {
    return;
  }
}

function tryBracketScan(text: string): Json | undefined {
  const startIdxObj = text.indexOf("{");
  const startIdxArr = text.indexOf("[");
  const start = [startIdxObj, startIdxArr]
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];

  if (start === undefined) {
    return;
  }

  const open = text[start] === "{" ? "{" : "[";
  const close = open === "{" ? "}" : "]";
  let depth = 0;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
    }

    if (depth === 0) {
      const candidate = text.slice(start, i + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        return;
      }
    }
  }

  return;
}

function extractFirstJsonBlock(text: string): Json | undefined {
  // 1) try direct parse
  const directResult = tryDirectParse(text);
  if (directResult !== undefined) {
    return directResult;
  }

  // 2) try code fence ```json ... ```
  const fenceResult = tryCodeFenceParse(text);
  if (fenceResult !== undefined) {
    return fenceResult;
  }

  // 3) bracket scanning for first object or array
  return tryBracketScan(text);
}

function subsetMatch(expected: Json, actual: Json): boolean {
  // primitives
  if (expected === null || typeof expected !== "object") {
    return expected === actual;
  }
  // arrays
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return false;
    }
    // Require at least that expected elements (by index) match if provided
    for (let i = 0; i < expected.length; i++) {
      if (!subsetMatch(expected[i], actual[i])) {
        return false;
      }
    }
    return true;
  }
  // object subset
  if (actual === null || typeof actual !== "object") {
    return false;
  }
  const eObj = expected as Record<string, unknown>;
  const aObj = actual as Record<string, unknown>;
  for (const key of Object.keys(eObj)) {
    if (!subsetMatch(eObj[key], aObj[key])) {
      return false;
    }
  }
  return true;
}

// Test cases will be loaded from data files at runtime

type DatasetLoadResult = {
  tests: Omit<SchemaTestCase, "expected">[];
  expectedMap: Map<string, ExpectedRecord>;
  error?: Error;
};

async function loadDatasets(): Promise<DatasetLoadResult> {
  try {
    const dataDir = resolveDataDir();
    const testsJsonl = await fs.readFile(
      path.join(dataDir, "json_generation_tests.jsonl"),
      "utf-8"
    );
    const expectedJsonl = await fs.readFile(
      path.join(dataDir, "json_generation_expected.jsonl"),
      "utf-8"
    );

    const tests = testsJsonl
      .split(NEWLINE_REGEX)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    const expecteds: ExpectedRecord[] = expectedJsonl
      .split(NEWLINE_REGEX)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    const expectedMap = new Map<string, ExpectedRecord>();
    for (const r of expecteds) {
      expectedMap.set(r.id, r);
    }

    return { tests, expectedMap };
  } catch (e: unknown) {
    return {
      tests: [],
      expectedMap: new Map(),
      error: e as Error,
    };
  }
}

function buildMessages(tc: Omit<SchemaTestCase, "expected">) {
  const schemaStr = JSON.stringify(tc.schema, null, 2);
  return [
    {
      role: "system" as const,
      content:
        "You must output only a single JSON document that strictly conforms to the given JSON Schema. Do not include any extra text or code fences.",
    },
    {
      role: "user" as const,
      content: [
        "Generate a JSON object that reflects the following facts.",
        "JSON Schema:",
        schemaStr,
        "Facts:",
        tc.promptFacts,
        "Output must be a single JSON only, with no additional text.",
      ].join("\n\n"),
    },
  ];
}

type ValidationResult = {
  valid: boolean;
  valuesOk: boolean;
  parsed: Json;
};

type ValidationContext = {
  expectedMap: Map<string, ExpectedRecord>;
  ajv: Ajv;
  logs: string[];
};

function validateTestCase(
  tc: Omit<SchemaTestCase, "expected">,
  parsed: Json,
  context: ValidationContext
): ValidationResult {
  const validate = context.ajv.compile(tc.schema);
  const valid = validate(parsed) as boolean;

  if (!valid) {
    context.logs.push(
      `[INFO] ${tc.id}: Schema validation errors: ${
        (validate.errors || [])
          .map((e) => `${e.instancePath} ${e.message}`)
          .join(", ") || "unknown"
      }`
    );
  }

  const expectedRec = context.expectedMap.get(tc.id);
  if (!expectedRec) {
    context.logs.push(
      `[WARN] ${tc.id}: No expected record found. Skipping value match.`
    );
  }

  const valuesOk = expectedRec
    ? subsetMatch(expectedRec.expected, parsed)
    : false;

  return { valid, valuesOk, parsed };
}

type ProcessContext = {
  model: LanguageModel;
  config: Record<string, unknown> | undefined;
  validation: ValidationContext;
};

async function processTestCase(
  tc: Omit<SchemaTestCase, "expected">,
  context: ProcessContext
): Promise<{ schemaValid: boolean; valueMatch: boolean; correct: boolean }> {
  const messages = buildMessages(tc);

  const temp = context.config?.temperature;
  const temperature = typeof temp === "number" ? temp : undefined;
  const { text } = await generateText({
    model: context.model,
    messages,
    ...(temperature !== undefined ? { temperature } : {}),
  });

  let parsed: Json | undefined;
  try {
    parsed = extractFirstJsonBlock(text);
  } catch {
    // ignore parse errors
  }

  if (parsed === undefined) {
    context.validation.logs.push(
      `[FAIL] ${tc.id}: Unable to parse JSON from model output.`
    );
    return { schemaValid: false, valueMatch: false, correct: false };
  }

  const {
    valid,
    valuesOk,
    parsed: validatedParsed,
  } = validateTestCase(tc, parsed, context.validation);

  const correct = valid && valuesOk;
  if (correct) {
    context.validation.logs.push(`[PASS] ${tc.id}`);
  } else {
    context.validation.logs.push(
      `[FAIL] ${tc.id}: schemaValid=${valid}, valuesOk=${valuesOk}. Output=${JSON.stringify(
        validatedParsed
      )}`
    );
  }

  return { schemaValid: valid, valueMatch: valuesOk, correct };
}

export const jsonGenerationBenchmark: LanguageModelV2Benchmark = {
  name: "json-generation",
  version: "2.1.0",
  description:
    "Evaluates schema-compliant JSON generation from natural language using JSON Schema prompts.",

  async run(
    model: LanguageModel,
    config?: Record<string, unknown>
  ): Promise<BenchmarkResult> {
    const logs: string[] = [];
    const ajv = new Ajv({ allErrors: true, strict: false });

    // Load datasets
    const { tests, expectedMap, error } = await loadDatasets();
    if (error) {
      return {
        score: 0,
        success: false,
        metrics: {},
        logs: [
          `[FATAL] Failed to load json-generation datasets: ${error.message}`,
        ],
        error,
      };
    }

    const context: ProcessContext = {
      model,
      config,
      validation: { expectedMap, ajv, logs },
    };

    const counts = await processAllTests(tests, context);
    return buildBenchmarkResult(tests.length, counts, logs);
  },
};

async function processAllTests(
  tests: Omit<SchemaTestCase, "expected">[],
  context: ProcessContext
): Promise<{
  schemaValidCount: number;
  valueMatchCount: number;
  correctCount: number;
}> {
  let schemaValidCount = 0;
  let valueMatchCount = 0;
  let correctCount = 0;

  for (const tc of tests) {
    try {
      const result = await processTestCase(tc, context);
      if (result.schemaValid) {
        schemaValidCount++;
      }
      if (result.valueMatch) {
        valueMatchCount++;
      }
      if (result.correct) {
        correctCount++;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      context.validation.logs.push(`[ERROR] ${tc.id}: ${msg}`);
    }
  }

  return { schemaValidCount, valueMatchCount, correctCount };
}

function buildBenchmarkResult(
  total: number,
  counts: {
    schemaValidCount: number;
    valueMatchCount: number;
    correctCount: number;
  },
  logs: string[]
): BenchmarkResult {
  const score = counts.correctCount / total;
  return {
    score,
    success: score >= 0.8,
    metrics: {
      total_cases: total,
      correct_count: counts.correctCount,
      schema_valid_count: counts.schemaValidCount,
      value_match_count: counts.valueMatchCount,
      accuracy: score,
    },
    logs,
  };
}

// A schema-only variant that validates structure/format without value matching
type SchemaOnlyTestCase = Omit<SchemaTestCase, "expected">;

type SchemaOnlyContext = {
  model: LanguageModel;
  config: Record<string, unknown> | undefined;
  ajv: Ajv;
  logs: string[];
};

async function loadSchemaOnlyTests(): Promise<{
  tests: SchemaOnlyTestCase[];
  error?: Error;
}> {
  try {
    const dataDir = resolveDataDir();
    const testsJsonl = await fs.readFile(
      path.join(dataDir, "json_generation_tests.jsonl"),
      "utf-8"
    );
    const tests = testsJsonl
      .split(LINE_SPLIT_REGEX)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    return { tests };
  } catch (e: unknown) {
    return { tests: [], error: e as Error };
  }
}

async function processSchemaOnlyTestCase(
  tc: SchemaOnlyTestCase,
  context: SchemaOnlyContext
): Promise<boolean> {
  const messages = buildMessages(tc);

  const temp = context.config?.temperature;
  const temperature = typeof temp === "number" ? temp : undefined;
  const { text } = await generateText({
    model: context.model,
    messages,
    ...(temperature !== undefined ? { temperature } : {}),
  });

  let parsed: Json | undefined;
  try {
    parsed = extractFirstJsonBlock(text);
  } catch {
    // ignore
  }
  if (parsed === undefined) {
    context.logs.push(
      `[FAIL] ${tc.id}: Could not parse JSON from model output.`
    );
    return false;
  }

  const validate = context.ajv.compile(tc.schema);
  const valid = validate(parsed) as boolean;
  if (valid) {
    context.logs.push(`[PASS] ${tc.id}`);
    return true;
  }

  context.logs.push(
    `[FAIL] ${tc.id}: Schema validation errors: ${
      (validate.errors || [])
        .map((e) => `${e.instancePath} ${e.message}`)
        .join(", ") || "unknown"
    }`
  );
  return false;
}

async function runSchemaOnlyTests(
  tests: SchemaOnlyTestCase[],
  context: SchemaOnlyContext
): Promise<number> {
  let schemaValidCount = 0;

  for (const tc of tests) {
    try {
      const isValid = await processSchemaOnlyTestCase(tc, context);
      if (isValid) {
        schemaValidCount++;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      context.logs.push(`[ERROR] ${tc.id}: ${msg}`);
    }
  }

  return schemaValidCount;
}

export const jsonGenerationSchemaOnlyBenchmark: LanguageModelV2Benchmark = {
  name: "json-generation-schema-only",
  version: "1.0.1",
  description:
    "Evaluates whether model outputs strictly conform to the provided JSON Schema (structure only).",

  async run(
    model: LanguageModel,
    config?: Record<string, unknown>
  ): Promise<BenchmarkResult> {
    const logs: string[] = [];
    const ajv = new Ajv({ allErrors: true, strict: false });

    const { tests, error } = await loadSchemaOnlyTests();
    if (error) {
      const msg = error.message;
      return {
        score: 0,
        success: false,
        metrics: {},
        logs: [`[FATAL] Failed to load schema-only tests: ${msg}`],
        error,
      };
    }

    const context: SchemaOnlyContext = { model, config, ajv, logs };
    const schemaValidCount = await runSchemaOnlyTests(tests, context);

    const total = tests.length;
    const score = total > 0 ? schemaValidCount / total : 0;
    return {
      score,
      success: score >= 0.8,
      metrics: {
        total_cases: total,
        schema_valid_count: schemaValidCount,
        accuracy: score,
      },
      logs,
    };
  },
};
