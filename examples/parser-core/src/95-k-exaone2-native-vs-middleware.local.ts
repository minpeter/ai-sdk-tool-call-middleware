import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, stepCountIs, wrapLanguageModel } from "ai";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import {
  kExaone2Protocol,
  kExaone2ToolMiddleware,
} from "../../../src/index";

const MODEL =
  process.env.MODEL ?? "LGAI-EXAONE/K-EXAONE-2.0-750B-A37B";
const RUNS = Number(process.env.RUNS ?? "5");
const ENABLE_THINKING = process.env.ENABLE_THINKING === "true";
const API_KEY = process.env.FRIENDLI_API_KEY;
const BASE_URL =
  process.env.FRIENDLI_BASE_URL ?? "https://api.friendli.ai/serverless/v1";

if (!API_KEY) {
  console.error("FRIENDLI_API_KEY is required");
  process.exit(1);
}

const friendli = createOpenAICompatible({
  name: "friendli",
  apiKey: API_KEY,
  baseURL: BASE_URL,
});

const weatherTool = {
  description: "Get the weather for a city. Units are metric or imperial.",
  inputSchema: z.object({
    city: z.string(),
    units: z.enum(["metric", "imperial"]).optional(),
  }),
  execute: async ({
    city,
    units,
  }: {
    city: string;
    units?: "metric" | "imperial";
  }) => ({
    city,
    units: units ?? "metric",
    temperature: city.toLowerCase().includes("seoul") ? 21 : 18,
    condition: "clear",
  }),
};

type PathName = "native" | "middleware";

interface RunMetrics {
  path: PathName;
  ok: boolean;
  wallMs: number;
  steps: number;
  toolCalls: number;
  toolNames: string[];
  finishReasons: string[];
  textChars: number;
  error?: string;
}

function providerOptions() {
  return {
    friendli: {
      parse_reasoning: true,
      chat_template_kwargs: {
        enable_thinking: ENABLE_THINKING,
      },
    },
  };
}

async function runOnce(path: PathName): Promise<RunMetrics> {
  const baseModel = friendli.chatModel(MODEL);
  const model =
    path === "middleware"
      ? wrapLanguageModel({
          model: baseModel,
          middleware: kExaone2ToolMiddleware,
        })
      : baseModel;

  const t0 = performance.now();
  try {
    const result = await generateText({
      model,
      temperature: 0,
      maxOutputTokens: 512,
      stopWhen: stepCountIs(3),
      providerOptions: providerOptions(),
      system:
        "You are a concise assistant. Prefer tools for weather questions.",
      prompt:
        "What is the weather in Seoul in metric units? Use get_weather. After the tool result, answer in one short sentence.",
      tools: {
        get_weather: weatherTool,
      },
    });

    const toolCalls = result.steps.flatMap((step) => step.toolCalls ?? []);
    return {
      path,
      ok: toolCalls.length > 0,
      wallMs: performance.now() - t0,
      steps: result.steps.length,
      toolCalls: toolCalls.length,
      toolNames: toolCalls.map((c) => c.toolName),
      finishReasons: result.steps.map((s) => String(s.finishReason)),
      textChars: (result.text ?? "").length,
    };
  } catch (error) {
    return {
      path,
      ok: false,
      wallMs: performance.now() - t0,
      steps: 0,
      toolCalls: 0,
      toolNames: [],
      finishReasons: [],
      textChars: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function stats(values: number[]) {
  if (values.length === 0) {
    return { n: 0, mean: 0, p50: 0, min: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const p50 = sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
  return {
    n: values.length,
    mean,
    p50,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function printPath(label: string, rows: RunMetrics[]) {
  const ok = rows.filter((r) => r.ok);
  const s = stats(ok.map((r) => r.wallMs));
  console.log(`\n## ${label}`);
  console.log(
    `success ${ok.length}/${rows.length}` +
      (ok.length === 0 ? "" : ` | wallMs mean=${s.mean.toFixed(0)} p50=${s.p50.toFixed(0)} min=${s.min.toFixed(0)} max=${s.max.toFixed(0)}`)
  );
  for (const [i, row] of rows.entries()) {
    console.log(
      `  #${i + 1} ok=${row.ok} wall=${row.wallMs.toFixed(0)}ms steps=${row.steps} tools=${row.toolCalls} names=[${row.toolNames.join(",")}] finish=[${row.finishReasons.join(",")}] textChars=${row.textChars}` +
        (row.error ? ` err=${row.error.slice(0, 160)}` : "")
    );
  }
}

async function pureParseMicrobench() {
  const protocol = kExaone2Protocol();
  const tools = [
    {
      type: "function" as const,
      name: "get_weather",
      description: "weather",
      inputSchema: {
        type: "object",
        properties: {
          city: { type: "string" },
          units: { type: "string" },
        },
      },
    },
  ];

  const xml = `<tool_call>
<function=get_weather>
<parameter=city>
Seoul
</parameter>
<parameter=units>
metric
</parameter>
</function>
</tool_call>`;

  const iterations = 1000;
  for (let i = 0; i < 50; i++) {
    protocol.parseGeneratedText({ text: xml, tools });
  }
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) {
    protocol.parseGeneratedText({ text: xml, tools });
  }
  const totalMs = performance.now() - t0;
  return {
    iterations,
    totalMs,
    avgUs: (totalMs * 1000) / iterations,
  };
}

async function main() {
  console.log("K-EXAONE-2.0 tool-call path bench");
  console.log(
    JSON.stringify(
      {
        model: MODEL,
        runs: RUNS,
        enableThinking: ENABLE_THINKING,
        baseURL: BASE_URL,
      },
      null,
      2
    )
  );

  console.log("\nwarmup native...");
  await runOnce("native");

  const nativeRows: RunMetrics[] = [];
  const mwRows: RunMetrics[] = [];

  for (let i = 0; i < RUNS; i++) {
    console.log(`\n--- run ${i + 1}/${RUNS}: native ---`);
    nativeRows.push(await runOnce("native"));
    console.log(`--- run ${i + 1}/${RUNS}: middleware ---`);
    mwRows.push(await runOnce("middleware"));
  }

  printPath("native tools API (no middleware)", nativeRows);
  printPath("kExaone2ToolMiddleware (prompt XML parse)", mwRows);

  const nativeOk = nativeRows.filter((r) => r.ok).map((r) => r.wallMs);
  const mwOk = mwRows.filter((r) => r.ok).map((r) => r.wallMs);
  const n = stats(nativeOk);
  const m = stats(mwOk);

  console.log("\n## comparison (successful end-to-end only)");
  if (n.n && m.n) {
    const delta = m.mean - n.mean;
    const pct = (delta / n.mean) * 100;
    console.log(
      `native  mean ${n.mean.toFixed(0)}ms (p50 ${n.p50.toFixed(0)}) over ${n.n}`
    );
    console.log(
      `middleware mean ${m.mean.toFixed(0)}ms (p50 ${m.p50.toFixed(0)}) over ${m.n}`
    );
    console.log(
      `middleware - native = ${delta.toFixed(0)}ms (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`
    );
  } else {
    console.log("not enough successful runs to compare means");
  }

  const parse = await pureParseMicrobench();
  console.log("\n## pure kExaone2 parse microbench (single XML tool call)");
  console.log(
    `${parse.iterations} iters: avg ${parse.avgUs.toFixed(2)}µs (total ${parse.totalMs.toFixed(2)}ms)`
  );
  console.log(
    "note: parse overhead is usually << model latency; e2e gap is mostly prompt/template/tool-loop behavior, not XML parsing CPU."
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
