/**
 * Local-only extended live matrix: probes areas beyond the previous
 * hardening rounds — hard schema shapes, unicode, markup-hostile strings,
 * streaming delta consistency, and text-leak invariants.
 *
 * Run:
 *   LIVE_MATRIX_MODELS=a,b pnpm dlx tsx examples/parser-core/src/94-extended-matrix.local.ts
 */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  generateText,
  type ModelMessage,
  streamText,
  type ToolSet,
  type TypedToolCall,
  wrapLanguageModel,
} from "ai";
import { z } from "zod";
import {
  hermesToolMiddleware,
  morphXmlToolMiddleware,
  qwen3CoderToolMiddleware,
  yamlXmlToolMiddleware,
} from "../../../src/preconfigured-middleware";

const OUT = process.env.LIVE_MATRIX_OUT ?? "/tmp/extended-matrix.jsonl";
const TIMEOUT = 120_000;

const provider = createOpenAICompatible({
  name: "freerouter",
  apiKey: requireEnv("FREEROUTER_API_KEY"),
  baseURL:
    process.env.FREEROUTER_BASE_URL ??
    "https://freerouter.minpeter.workers.dev/v1",
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required to run this local matrix script`);
  }
  return value;
}

const MIDDLEWARES = {
  hermes: hermesToolMiddleware,
  morphXml: morphXmlToolMiddleware,
  qwen3Coder: qwen3CoderToolMiddleware,
  yamlXml: yamlXmlToolMiddleware,
} as const;
type MwName = keyof typeof MIDDLEWARES;
type FullStreamPart =
  ReturnType<typeof streamText>["fullStream"] extends AsyncIterable<infer Part>
    ? Part
    : never;

interface StreamInvariantOptions {
  modelId: string;
  mw: MwName;
  parserErrors: string[];
  prompt: string;
  tools: ToolSet;
}

interface StreamInvariantState {
  readonly calls: TypedToolCall<ToolSet>[];
  readonly deltas: Map<string, string>;
  readonly ended: Set<string>;
  readonly notes: string[];
  readonly started: Set<string>;
  text: string;
}

const MODELS = (
  process.env.LIVE_MATRIX_MODELS?.split(",") ?? [
    // regression set (used in earlier hardening rounds)
    "meta-llama/llama-3.1-8b-instruct",
    "qwen/qwen2.5-7b-instruct",
    "openai/gpt-oss-20b",
    "zai-org/glm-4.7",
    "moonshotai/kimi-k2.5",
    // new coverage
    "deepseek-ai/deepseek-v3.2",
    "minimaxai/minimax-m2.1",
    "mistralai/mistral-small-latest",
    "nvidia/nvidia-nemotron-nano-9b-v2",
    "ibm-granite/granite-4.0-h-micro",
    "upstage/solar-pro-2",
    "google/gemma-4-31b-it",
  ]
).map((m) => m.trim());

/** Protocol markup that must never leak into user-visible text. */
const LEAK_PATTERNS = [
  "<tool_call",
  "</tool_call",
  "<function=",
  "</function>",
  "<tools>",
  "[TOOL_CALLS]",
  "<|tool_call",
];

function leakCheck(text: string): string {
  const hits = LEAK_PATTERNS.filter((p) => text.includes(p));
  return hits.length > 0 ? ` TEXT-LEAK(${hits.join("|")})` : "";
}

function makeModel(modelId: string, mw: MwName) {
  return wrapLanguageModel({
    model: provider(modelId),
    middleware: MIDDLEWARES[mw],
  });
}

function collectOnError(errors: string[]) {
  return {
    toolCallMiddleware: {
      onError: (message: string, metadata?: Record<string, unknown>) => {
        errors.push(
          `${message} ${metadata ? JSON.stringify(metadata).slice(0, 300) : ""}`
        );
      },
    },
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => deepEqual(value, b[index]))
    );
  }
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  ) {
    return false;
  }

  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord).sort();
  const bKeys = Object.keys(bRecord).sort();
  return (
    aKeys.length === bKeys.length &&
    aKeys.every(
      (key, index) =>
        key === bKeys[index] && deepEqual(aRecord[key], bRecord[key])
    )
  );
}

function createInvariantState(): StreamInvariantState {
  return {
    deltas: new Map<string, string>(),
    started: new Set<string>(),
    ended: new Set<string>(),
    calls: [],
    text: "",
    notes: [],
  };
}

function pushNoteWhen(
  notes: string[],
  condition: boolean,
  message: string
): void {
  if (condition) {
    notes.push(message);
  }
}

function recordStreamPart(
  part: FullStreamPart,
  state: StreamInvariantState
): void {
  switch (part.type) {
    case "text-delta":
      state.text += part.text;
      break;
    case "tool-input-start":
      pushNoteWhen(
        state.notes,
        state.started.has(part.id),
        `DUP-INPUT-START(${part.id})`
      );
      state.started.add(part.id);
      state.deltas.set(part.id, "");
      break;
    case "tool-input-delta":
      pushNoteWhen(
        state.notes,
        !state.started.has(part.id),
        `DELTA-BEFORE-START(${part.id})`
      );
      state.deltas.set(part.id, (state.deltas.get(part.id) ?? "") + part.delta);
      break;
    case "tool-input-end":
      pushNoteWhen(
        state.notes,
        !state.started.has(part.id),
        `END-BEFORE-START(${part.id})`
      );
      pushNoteWhen(
        state.notes,
        state.ended.has(part.id),
        `DUP-INPUT-END(${part.id})`
      );
      state.ended.add(part.id);
      break;
    case "tool-call":
      state.calls.push(part);
      pushNoteWhen(
        state.notes,
        !state.started.has(part.toolCallId),
        `CALL-WITHOUT-INPUT-START(${part.toolCallId})`
      );
      break;
    case "error":
      throw new Error(`stream error: ${String(part.error).slice(0, 300)}`);
    default:
      break;
  }
}

function recordMissingInputEnds(state: StreamInvariantState): void {
  for (const id of state.started) {
    pushNoteWhen(state.notes, !state.ended.has(id), `NO-INPUT-END(${id})`);
  }
}

function recordDeltaMismatches(state: StreamInvariantState): void {
  for (const call of state.calls) {
    const raw = state.deltas.get(call.toolCallId);
    if (raw === undefined) {
      continue;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!deepEqual(parsed, call.input)) {
        state.notes.push(
          `DELTA-MISMATCH(${call.toolCallId}: deltas=${raw.slice(0, 120)} input=${JSON.stringify(call.input).slice(0, 120)})`
        );
      }
    } catch {
      state.notes.push(
        `DELTA-NOT-JSON(${call.toolCallId}: ${raw.slice(0, 120)})`
      );
    }
  }
}

/**
 * Streams a prompt and checks lifecycle invariants shared by all streaming
 * scenarios: id consistency, input-start/end pairing, and that concatenated
 * tool-input-delta chunks parse to the same object as the final tool-call
 * input.
 */
async function streamWithInvariants(opts: StreamInvariantOptions) {
  const result = streamText({
    model: makeModel(opts.modelId, opts.mw),
    tools: opts.tools,
    prompt: opts.prompt,
    providerOptions: collectOnError(opts.parserErrors),
    abortSignal: AbortSignal.timeout(TIMEOUT),
  });
  const state = createInvariantState();
  for await (const part of result.fullStream) {
    recordStreamPart(part, state);
  }
  recordMissingInputEnds(state);
  recordDeltaMismatches(state);
  const finishReason = await result.finishReason;
  return {
    calls: state.calls,
    text: state.text,
    notes: state.notes,
    finishReason,
  };
}

interface Scenario {
  name: string;
  run: (modelId: string, mw: MwName, parserErrors: string[]) => Promise<string>;
}

const scenarios: Scenario[] = [
  {
    // Markup-hostile string content: HTML file write via XML-ish protocols.
    name: "gen-html-content",
    run: async (modelId, mw, parserErrors) => {
      const result = await generateText({
        model: makeModel(modelId, mw),
        tools: {
          write_file: {
            description: "Write a text file to disk.",
            inputSchema: z.object({
              path: z.string(),
              content: z.string().describe("Exact file content, verbatim."),
            }),
          },
        },
        prompt:
          'Create index.html containing a minimal HTML5 page: doctype, <html>, <head> with <title>Demo</title>, and a <body> with one <div class="app">Hello & welcome</div>. Use the write_file tool with the full file content.',
        providerOptions: collectOnError(parserErrors),
        abortSignal: AbortSignal.timeout(TIMEOUT),
      });
      const call = result.toolCalls.find((tc) => tc.toolName === "write_file");
      if (!call) {
        throw new Error(
          `no write_file call; text=${JSON.stringify(result.text.slice(0, 200))}`
        );
      }
      const input = call.input as { path?: unknown; content?: unknown };
      if (typeof input.content !== "string" || input.content.length < 40) {
        throw new Error(`bad content: ${JSON.stringify(input).slice(0, 300)}`);
      }
      const c = input.content;
      const missing = ["<html", "<title>", "<div", "&"].filter(
        (m) => !c.includes(m)
      );
      if (missing.length > 0) {
        throw new Error(
          `content lost markup (${missing.join(",")}): ${JSON.stringify(c.slice(0, 300))}`
        );
      }
      return `len=${c.length}${leakCheck(result.text)}`;
    },
  },
  {
    // Unicode / Korean / emoji round-trip.
    name: "gen-unicode",
    run: async (modelId, mw, parserErrors) => {
      const result = await generateText({
        model: makeModel(modelId, mw),
        tools: {
          send_message: {
            description: "Send a chat message.",
            inputSchema: z.object({
              recipient: z.string(),
              body: z.string().describe("Message body, verbatim."),
            }),
          },
        },
        prompt:
          'Send the message "안녕하세요! 오늘 회의는 3시입니다 🚀 <중요>" to 민석. Use send_message with the body exactly as quoted.',
        providerOptions: collectOnError(parserErrors),
        abortSignal: AbortSignal.timeout(TIMEOUT),
      });
      const call = result.toolCalls.find((c) => c.toolName === "send_message");
      if (!call) {
        throw new Error(
          `no send_message call; text=${JSON.stringify(result.text.slice(0, 200))}`
        );
      }
      const input = call.input as { recipient?: unknown; body?: unknown };
      if (typeof input.body !== "string") {
        throw new Error(`bad body: ${JSON.stringify(input).slice(0, 200)}`);
      }
      const missing = ["안녕하세요", "3시", "🚀"].filter(
        (m) => !(input.body as string).includes(m)
      );
      if (missing.length > 0) {
        throw new Error(
          `body lost content (${missing.join(",")}): ${JSON.stringify(input.body)}`
        );
      }
      return `body=${JSON.stringify(input.body).slice(0, 80)}${leakCheck(result.text)}`;
    },
  },
  {
    // Mixed primitive types + numeric-looking strings must stay strings.
    name: "gen-type-fidelity",
    run: async (modelId, mw, parserErrors) => {
      const result = await generateText({
        model: makeModel(modelId, mw),
        tools: {
          create_shipment: {
            description: "Create a shipment order.",
            inputSchema: z.object({
              zip: z.string().describe("5-digit ZIP code as a string"),
              weightKg: z.number(),
              express: z.boolean(),
              items: z.array(z.string()).describe("item names"),
            }),
          },
        },
        prompt:
          "Create a shipment to ZIP 01234, weight 2.5 kg, express shipping, items: bolt, nut. Use create_shipment.",
        providerOptions: collectOnError(parserErrors),
        abortSignal: AbortSignal.timeout(TIMEOUT),
      });
      const call = result.toolCalls.find(
        (c) => c.toolName === "create_shipment"
      );
      if (!call) {
        throw new Error(
          `no create_shipment call; text=${JSON.stringify(result.text.slice(0, 200))}`
        );
      }
      const input = call.input as Record<string, unknown>;
      const problems: string[] = [];
      if (typeof input.zip !== "string") {
        problems.push(`zip:${typeof input.zip}`);
      }
      if (typeof input.weightKg !== "number") {
        problems.push(`weightKg:${typeof input.weightKg}`);
      }
      if (typeof input.express !== "boolean") {
        problems.push(`express:${typeof input.express}`);
      }
      if (!Array.isArray(input.items)) {
        problems.push("items:not-array");
      }
      if (problems.length > 0) {
        throw new Error(
          `type fidelity: ${problems.join(",")} input=${JSON.stringify(input)}`
        );
      }
      return `input=${JSON.stringify(input)}${leakCheck(result.text)}`;
    },
  },
  {
    // Streaming: long multi-line code content + delta-consistency invariant.
    name: "stream-longcode",
    run: async (modelId, mw, parserErrors) => {
      const { calls, text, notes, finishReason } = await streamWithInvariants({
        modelId,
        mw,
        tools: {
          write_file: {
            description: "Write a source file.",
            inputSchema: z.object({
              path: z.string(),
              content: z.string().describe("Full file content, verbatim."),
            }),
          },
        },
        prompt:
          'Write a Python file fizzbuzz.py: a function fizzbuzz(n) returning "Fizz"/"Buzz"/"FizzBuzz"/str(n), plus a __main__ loop printing 1..30. Include a docstring with the words "classic interview question". Use write_file once with the complete file.',
        parserErrors,
      });
      const call = calls.find((c) => c.toolName === "write_file");
      if (!call) {
        throw new Error(
          `no write_file call; finish=${finishReason}; text=${JSON.stringify(text.slice(0, 200))}`
        );
      }
      const input = call.input as { content?: unknown };
      if (typeof input.content !== "string" || !input.content.includes("\n")) {
        throw new Error(
          `content not multi-line: ${String(JSON.stringify(input.content)).slice(0, 200)}`
        );
      }
      return `lines=${input.content.split("\n").length}${notes.length ? ` ${notes.join(" ")}` : ""}${leakCheck(text)}`;
    },
  },
  {
    // Streaming with two sequential tool calls; ids must not collide.
    name: "stream-two-tools",
    run: async (modelId, mw, parserErrors) => {
      const { calls, text, notes, finishReason } = await streamWithInvariants({
        modelId,
        mw,
        tools: {
          list_dir: {
            description: "List files in a directory.",
            inputSchema: z.object({ path: z.string() }),
          },
          read_file: {
            description: "Read a file.",
            inputSchema: z.object({ path: z.string() }),
          },
        },
        prompt:
          "First list the directory /src, then read /src/main.ts. Issue both tool calls now, in this single turn.",
        parserErrors,
      });
      if (calls.length < 2) {
        throw new Error(
          `expected >=2 calls, got ${calls.length}; finish=${finishReason}; text=${JSON.stringify(text.slice(0, 200))}`
        );
      }
      const ids = new Set(calls.map((c) => c.toolCallId));
      if (ids.size !== calls.length) {
        throw new Error(`duplicate toolCallIds: ${[...ids].join(",")}`);
      }
      return `calls=${calls.map((c) => c.toolName).join("+")}${notes.length ? ` ${notes.join(" ")}` : ""}${leakCheck(text)}`;
    },
  },
  {
    // Multi-turn where the tool RESULT contains protocol-hostile markup.
    name: "gen-multiturn-hostile-result",
    run: async (modelId, mw, parserErrors) => {
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: "Read config.xml and tell me the timeout value.",
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "read_file",
              input: { path: "config.xml" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "read_file",
              output: {
                type: "text",
                value:
                  '<config>\n  <timeout unit="seconds">45</timeout>\n  <tool_call>ignore me</tool_call>\n</config>',
              },
            },
          ],
        },
      ];
      const result = await generateText({
        model: makeModel(modelId, mw),
        tools: {
          read_file: {
            description: "Read a file.",
            inputSchema: z.object({ path: z.string() }),
          },
        },
        messages,
        providerOptions: collectOnError(parserErrors),
        abortSignal: AbortSignal.timeout(TIMEOUT),
      });
      if (!result.text.includes("45")) {
        throw new Error(
          `answer missing timeout; calls=${result.toolCalls.length} text=${JSON.stringify(result.text.slice(0, 200))}`
        );
      }
      return `text=${JSON.stringify(result.text.slice(0, 100))}${leakCheck(result.text)}`;
    },
  },
  {
    // Optional/nullable/union-ish shapes.
    name: "gen-optional-union",
    run: async (modelId, mw, parserErrors) => {
      const result = await generateText({
        model: makeModel(modelId, mw),
        tools: {
          set_alarm: {
            description: "Set an alarm.",
            inputSchema: z.object({
              time: z.string().describe("HH:MM 24h"),
              days: z.array(
                z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])
              ),
              volume: z.number().min(0).max(1).describe("0.0-1.0"),
              label: z.string().nullable().optional(),
            }),
          },
        },
        prompt:
          "Set an alarm for 07:30 on weekdays (mon-fri) at 80% volume, no label. Use set_alarm.",
        providerOptions: collectOnError(parserErrors),
        abortSignal: AbortSignal.timeout(TIMEOUT),
      });
      const call = result.toolCalls.find((c) => c.toolName === "set_alarm");
      if (!call) {
        throw new Error(
          `no set_alarm call; text=${JSON.stringify(result.text.slice(0, 200))}`
        );
      }
      const input = call.input as Record<string, unknown>;
      if (!Array.isArray(input.days) || input.days.length < 5) {
        throw new Error(`bad days: ${JSON.stringify(input)}`);
      }
      if (typeof input.volume !== "number" || input.volume > 1) {
        throw new Error(`bad volume: ${JSON.stringify(input.volume)}`);
      }
      return `input=${JSON.stringify(input).slice(0, 120)}${leakCheck(result.text)}`;
    },
  },
];

type ResultCategory =
  | "pass"
  | "expectation-miss"
  | "malformed-output"
  | "output-leak"
  | "provider-error"
  | "stream-invariant"
  | "harness-error"
  | "unclassified";

interface RunResult {
  attempts: number;
  category: ResultCategory;
  detail: string;
  middleware: string;
  model: string;
  ms: number;
  ok: boolean;
  parserErrors: string[];
  scenario: string;
}

const PROVIDER_RETRIES = Number.parseInt(
  process.env.LIVE_MATRIX_PROVIDER_RETRIES ?? "0",
  10
);
const CONCURRENCY = Number.parseInt(
  process.env.LIVE_MATRIX_CONCURRENCY ?? "10",
  10
);

const EXPECTATION_MISS_PATTERNS = [
  /^answer missing /,
  /^bad /,
  /^body lost /,
  /^content not multi-line:/,
  /^expected >=/,
  /^no [a-z_]+ call;/,
  /^type fidelity:/,
];

const PROVIDER_ERROR_PATTERNS = [
  /AI_APICallError/i,
  /fetch failed/i,
  /Input validation error/i,
  /Invalid model:/i,
  /Key limit exceeded/i,
  /litellm\.APIError/i,
  /model .* does not exist/i,
  /non-serverless model/i,
  /only supports streaming responses/i,
  /operation was aborted/i,
  /rate limit/i,
  /status code [45]\d\d/i,
  /subscription plan/i,
  /System role not supported/i,
  /Conversation roles must alternate/i,
  /enum system not in user,assistant/i,
  /Expected 'function\.name'/i,
];

const RETRYABLE_PROVIDER_ERROR_PATTERNS = [
  /operation was aborted/i,
  /rate limit/i,
  /status code 429/i,
  /status code 5\d\d/i,
  /timeout/i,
];

const STREAM_INVARIANT_PATTERNS = [
  /CALL-WITHOUT-INPUT-START/,
  /DELTA-BEFORE-START/,
  /DELTA-MISMATCH/,
  /DELTA-NOT-JSON/,
  /DUP-INPUT-/,
  /END-BEFORE-START/,
  /NO-INPUT-END/,
  /TEXT-LEAK/,
];

const HARNESS_ERROR_PATTERN =
  /Cannot read properties|is not a function|ReferenceError|TypeError/;

function classifyFailure(
  detail: string,
  parserErrors: string[]
): ResultCategory {
  if (PROVIDER_ERROR_PATTERNS.some((pattern) => pattern.test(detail))) {
    return "provider-error";
  }
  if (parserErrors.length > 0) {
    return "malformed-output";
  }
  if (STREAM_INVARIANT_PATTERNS.some((pattern) => pattern.test(detail))) {
    return "stream-invariant";
  }
  if (HARNESS_ERROR_PATTERN.test(detail)) {
    return "harness-error";
  }
  if (EXPECTATION_MISS_PATTERNS.some((pattern) => pattern.test(detail))) {
    return "expectation-miss";
  }
  return "unclassified";
}

function classifySuccess(
  detail: string,
  parserErrors: string[]
): ResultCategory {
  if (STREAM_INVARIANT_PATTERNS.some((pattern) => pattern.test(detail))) {
    return "stream-invariant";
  }
  if (detail.includes("TEXT-LEAK")) {
    return "output-leak";
  }
  if (parserErrors.length > 0) {
    return "malformed-output";
  }
  return "pass";
}

function isRetryableProviderError(detail: string): boolean {
  return RETRYABLE_PROVIDER_ERROR_PATTERNS.some((pattern) =>
    pattern.test(detail)
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOne(
  modelId: string,
  mw: MwName,
  scenario: Scenario
): Promise<RunResult> {
  const start = Date.now();
  for (let attempt = 1; ; attempt += 1) {
    const parserErrors: string[] = [];
    try {
      const detail = await scenario.run(modelId, mw, parserErrors);
      const category = classifySuccess(detail, parserErrors);
      return {
        attempts: attempt,
        category,
        model: modelId,
        middleware: mw,
        scenario: scenario.name,
        ok: category === "pass",
        detail,
        parserErrors,
        ms: Date.now() - start,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const category = classifyFailure(detail, parserErrors);
      if (
        category === "provider-error" &&
        isRetryableProviderError(detail) &&
        attempt <= PROVIDER_RETRIES
      ) {
        console.log(
          `[RETRY ${attempt}/${PROVIDER_RETRIES}] ${modelId} ${mw} ${scenario.name} — ${detail.slice(0, 160)}`
        );
        await delay(2000 * attempt);
        continue;
      }
      return {
        attempts: attempt,
        category,
        model: modelId,
        middleware: mw,
        scenario: scenario.name,
        ok: false,
        detail,
        parserErrors,
        ms: Date.now() - start,
      };
    }
  }
}

function printCategorySummary(results: RunResult[]): void {
  const categories: ResultCategory[] = [
    "pass",
    "expectation-miss",
    "malformed-output",
    "output-leak",
    "provider-error",
    "stream-invariant",
    "harness-error",
    "unclassified",
  ];
  console.log("\nBy category:");
  for (const category of categories) {
    const count = results.filter(
      (result) => result.category === category
    ).length;
    console.log(`  ${category.padEnd(20)} ${count}`);
  }
}

function printDimensionSummary(
  results: RunResult[],
  label: string,
  select: (result: RunResult) => string
): void {
  const groups = new Map<string, RunResult[]>();
  for (const result of results) {
    const key = select(result);
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  console.log(`\nBy ${label}:`);
  for (const [key, group] of [...groups].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const passed = group.filter((result) => result.category === "pass").length;
    const rate = ((passed / group.length) * 100).toFixed(1);
    console.log(`  ${key.padEnd(42)} ${passed}/${group.length} (${rate}%)`);
  }
}

async function main() {
  const resume = process.env.LIVE_MATRIX_RESUME === "1";
  const existingResults: RunResult[] =
    resume && existsSync(OUT)
      ? readFileSync(OUT, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as RunResult)
      : [];
  if (!resume) {
    writeFileSync(OUT, "");
  }
  const jobs: Array<() => Promise<void>> = [];
  const results: RunResult[] = [...existingResults];
  const completed = new Set(
    existingResults.map(
      (result) =>
        `${result.model}\u0000${result.middleware}\u0000${result.scenario}`
    )
  );

  for (const scenario of scenarios) {
    for (const mw of Object.keys(MIDDLEWARES) as MwName[]) {
      for (const model of MODELS) {
        const key = `${model}\u0000${mw}\u0000${scenario.name}`;
        if (completed.has(key)) {
          continue;
        }
        jobs.push(async () => {
          const r = await runOne(model, mw, scenario);
          results.push(r);
          appendFileSync(OUT, `${JSON.stringify(r)}\n`);
          console.log(
            `[${r.category.toUpperCase()}] ${r.model} ${r.middleware} ${r.scenario} (${r.ms}ms, attempts=${r.attempts})${r.ok ? ` ${r.detail.slice(0, 160)}` : ` — ${r.detail.slice(0, 200)}`}${r.parserErrors.length ? ` [onError x${r.parserErrors.length}]` : ""}`
          );
        });
      }
    }
  }

  if (existingResults.length > 0) {
    console.log(
      `Resuming with ${existingResults.length} completed results; ${jobs.length} remaining.`
    );
  }

  let cursor = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor];
        cursor += 1;
        await job();
      }
    })
  );

  const failures = results.filter((r) => !r.ok);
  console.log(
    `\n=== ${results.length - failures.length}/${results.length} passed ===`
  );
  printCategorySummary(results);
  printDimensionSummary(results, "model", (result) => result.model);
  printDimensionSummary(results, "middleware", (result) => result.middleware);
  printDimensionSummary(results, "scenario", (result) => result.scenario);
  console.log("\nFailure details:");
  for (const f of failures) {
    console.log(
      `${f.category.toUpperCase()} ${f.model} ${f.middleware} ${f.scenario}: ${f.detail.slice(0, 180)}`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
