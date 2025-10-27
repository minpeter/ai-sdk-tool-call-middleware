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
    return undefined;
  }
}

function tryCodeFenceParse(text: string): Json | undefined {
  const fenceMatch = text.match(JSON_FENCE_REGEX) || text.match(CODE_FENCE_REGEX);
  if (!fenceMatch) {
    return undefined;
  }
  
  const inner = fenceMatch[1].trim();
  try {
    return JSON.parse(inner);
  } catch {
    return undefined;
  }
}

function tryBracketScan(text: string): Json | undefined {
  const startIdxObj = text.indexOf("{");
  const startIdxArr = text.indexOf("[");
  const start = [startIdxObj, startIdxArr]
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];
  
  if (start === undefined) {
    return undefined;
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
        return undefined;
      }
    }
  }
  
  return undefined;
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

function validateTestCase(
  tc: Omit<SchemaTestCase, "expected">,
  parsed: Json,
  expectedMap: Map<string, ExpectedRecord>,
  ajv: Ajv,
  logs: string[]
): ValidationResult {
  const validate = ajv.compile(tc.schema);
  const valid = validate(parsed) as boolean;
  
  if (!valid) {
    logs.push(
      `[INFO] ${tc.id}: Schema validation errors: ${
        (validate.errors || [])
          .map((e) => `${e.instancePath} ${e.message}`)
          .join(", ") || "unknown"
      }`
    );
  }

  const expectedRec = expectedMap.get(tc.id);
  if (!expectedRec) {
    logs.push(
      `[WARN] ${tc.id}: No expected record found. Skipping value match.`
    );
  }
  
  const valuesOk = expectedRec
    ? subsetMatch(expectedRec.expected, parsed)
    : false;

  return { valid, valuesOk, parsed };
}

async function processTestCase(
  tc: Omit<SchemaTestCase, "expected">,
  model: LanguageModel,
  config: Record<string, unknown> | undefined,
  expectedMap: Map<string, ExpectedRecord>,
  ajv: Ajv,
  logs: string[]
): Promise<{ schemaValid: boolean; valueMatch: boolean; correct: boolean }> {
  const messages = buildMessages(tc);
  
  const temp = config?.temperature;
  const temperature = typeof temp === "number" ? temp : undefined;
  const { text } = await generateText({
    model,
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
    logs.push(`[FAIL] ${tc.id}: Unable to parse JSON from model output.`);
    return { schemaValid: false, valueMatch: false, correct: false };
  }

  const { valid, valuesOk, parsed: validatedParsed } = validateTestCase(
    tc,
    parsed,
    expectedMap,
    ajv,
    logs
  );

  const correct = valid && valuesOk;
  if (correct) {
    logs.push(`[PASS] ${tc.id}`);
  } else {
    logs.push(
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

    let schemaValidCount = 0;
    let valueMatchCount = 0;
    let correctCount = 0;

    // Load datasets
    const { tests, expectedMap, error } = await loadDatasets();
    if (error) {
      const msg = error.message;
      return {
        score: 0,
        success: false,
        metrics: {},
        logs: [`[FATAL] Failed to load json-generation datasets: ${msg}`],
        error,
      };
    }

    // Process each test case
    for (const tc of tests) {
      try {
        const result = await processTestCase(tc, model, config, expectedMap, ajv, logs);
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
        logs.push(`[ERROR] ${tc.id}: ${msg}`);
      }
    }

    const total = tests.length;
    const score = correctCount / total;
    return {
      score,
      success: score >= 0.8,
      metrics: {
        total_cases: total,
        correct_count: correctCount,
        schema_valid_count: schemaValidCount,
        value_match_count: valueMatchCount,
        accuracy: score,
      },
      logs,
    };
  },
};

// A schema-only variant that validates structure/format without value matching
type SchemaOnlyTestCase = Omit<SchemaTestCase, "expected">;

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

    // Load tests
    let tests: SchemaOnlyTestCase[] = [];
    try {
      const dataDir = resolveDataDir();
      const testsJsonl = await fs.readFile(
        path.join(dataDir, "json_generation_tests.jsonl"),
        "utf-8"
      );
      tests = testsJsonl
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        score: 0,
        success: false,
        metrics: {},
        logs: [`[FATAL] Failed to load schema-only tests: ${msg}`],
        error: e as Error,
      };
    }

    let schemaValidCount = 0;

    for (const tc of tests) {
      try {
        const schemaStr = JSON.stringify(tc.schema, null, 2);
        const messages = [
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

        const temp = config?.temperature;
        const temperature = typeof temp === "number" ? temp : undefined;
        const { text } = await generateText({
          model,
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
          logs.push(`[FAIL] ${tc.id}: Could not parse JSON from model output.`);
          continue;
        }

        const validate = ajv.compile(tc.schema);
        const valid = validate(parsed) as boolean;
        if (valid) {
          schemaValidCount++;
          logs.push(`[PASS] ${tc.id}`);
        } else {
          logs.push(
            `[FAIL] ${tc.id}: Schema validation errors: ${
              (validate.errors || [])
                .map((e) => `${e.instancePath} ${e.message}`)
                .join(", ") || "unknown"
            }`
          );
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        logs.push(`[ERROR] ${tc.id}: ${msg}`);
      }
    }

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
