import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, stepCountIs, wrapLanguageModel } from "ai";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { kExaone2ToolMiddleware } from "../../../src/index";

const MODEL = process.env.MODEL ?? "LGAI-EXAONE/K-EXAONE-2.0-750B-A37B";
const RUNS = Number(process.env.RUNS ?? "3");
const ENABLE_THINKING = process.env.ENABLE_THINKING === "true";
const MAX_STEPS = Number(process.env.MAX_STEPS ?? "8");
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS ?? "900");
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

type PathName = "native" | "middleware";

interface ToolCallTrace {
  step: number;
  toolName: string;
  input: unknown;
}

interface RunMetrics {
  path: PathName;
  ok: boolean;
  wallMs: number;
  steps: number;
  toolCalls: number;
  uniqueTools: string[];
  toolNames: string[];
  finishReasons: string[];
  text: string;
  traces: ToolCallTrace[];
  checks: Record<string, boolean>;
  error?: string;
}

const db = {
  users: {
    u_kim: {
      id: "u_kim",
      name: "Kim",
      homeCity: "Seoul",
      locale: "ko-KR",
      preferredUnits: "metric" as const,
    },
    u_lee: {
      id: "u_lee",
      name: "Lee",
      homeCity: "Busan",
      locale: "ko-KR",
      preferredUnits: "metric" as const,
    },
  },
  inventory: {
    umbrella: { sku: "umbrella", stock: 12, priceKrw: 15000 },
    sunscreen: { sku: "sunscreen", stock: 4, priceKrw: 22000 },
    heat_pack: { sku: "heat_pack", stock: 9, priceKrw: 8000 },
  },
};

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

function buildTools() {
  return {
    resolve_user_profile: {
      description:
        "Resolve a user profile by userId or display name. Returns home city and unit preference.",
      inputSchema: z.object({
        query: z.object({
          userId: z.string().optional(),
          displayName: z.string().optional(),
        }),
        includePreferences: z.boolean().default(true),
      }),
      execute: async ({
        query,
        includePreferences,
      }: {
        query: { userId?: string; displayName?: string };
        includePreferences: boolean;
      }) => {
        const users = Object.values(db.users);
        const normalize = (value: string | undefined) =>
          value?.trim().toLowerCase() ?? "";
        const hit =
          users.find((u) => u.id === query.userId) ??
          users.find((u) => normalize(u.name) === normalize(query.displayName)) ??
          users.find((u) => normalize(u.name) === normalize(query.userId)) ??
          users.find((u) => normalize(u.id) === normalize(query.displayName));
        if (!hit) {
          return {
            found: false as const,
            reason: "user_not_found",
            hint: 'Use query.displayName="Kim" or query.userId="u_kim".',
            knownUsers: users.map((u) => ({ id: u.id, name: u.name })),
          };
        }
        return {
          found: true as const,
          user: {
            id: hit.id,
            name: hit.name,
            homeCity: hit.homeCity,
            ...(includePreferences
              ? {
                  preferences: {
                    locale: hit.locale,
                    units: hit.preferredUnits,
                  },
                }
              : {}),
          },
        };
      },
    },

    get_weather_bundle: {
      description:
        "Fetch weather for one or more locations with nested options. Supports multi-city batching.",
      inputSchema: z.object({
        locations: z
          .array(
            z.object({
              city: z.string(),
              countryCode: z.string().optional(),
              district: z.string().optional(),
            })
          )
          .min(1),
        options: z.object({
          units: z.enum(["metric", "imperial"]),
          includeHourly: z.boolean().default(false),
          fields: z
            .array(
              z.enum([
                "temperature",
                "condition",
                "humidity",
                "wind",
                "aqi",
              ])
            )
            .default(["temperature", "condition"]),
        }),
      }),
      execute: async ({
        locations,
        options,
      }: {
        locations: Array<{
          city: string;
          countryCode?: string;
          district?: string;
        }>;
        options: {
          units: "metric" | "imperial";
          includeHourly: boolean;
          fields: string[];
        };
      }) => {
        const baseTemp: Record<string, number> = {
          seoul: 21,
          busan: 24,
          incheon: 19,
        };
        return {
          units: options.units,
          results: locations.map((loc) => {
            const key = loc.city.toLowerCase();
            const temperature = baseTemp[key] ?? 20;
            const payload: Record<string, unknown> = {
              city: loc.city,
              countryCode: loc.countryCode ?? "KR",
              district: loc.district ?? null,
            };
            if (options.fields.includes("temperature")) {
              payload.temperature = temperature;
            }
            if (options.fields.includes("condition")) {
              payload.condition = temperature >= 23 ? "humid" : "clear";
            }
            if (options.fields.includes("humidity")) {
              payload.humidity = temperature >= 23 ? 78 : 52;
            }
            if (options.fields.includes("wind")) {
              payload.wind = { speed: 3.2, direction: "NE" };
            }
            if (options.fields.includes("aqi")) {
              payload.aqi = { value: 47, category: "good" };
            }
            if (options.includeHourly) {
              payload.hourly = [temperature, temperature + 1, temperature - 1];
            }
            return payload;
          }),
        };
      },
    },

    search_catalog: {
      description:
        "Search product catalog with filters, sort, and pagination. Nested filter object.",
      inputSchema: z.object({
        q: z.string(),
        filters: z
          .object({
            tags: z.array(z.string()).optional(),
            price: z
              .object({
                min: z.number().optional(),
                max: z.number().optional(),
              })
              .optional(),
            inStockOnly: z.boolean().optional(),
          })
          .optional(),
        sort: z
          .object({
            field: z.enum(["price", "stock", "relevance"]),
            order: z.enum(["asc", "desc"]),
          })
          .optional(),
        page: z.object({
          limit: z.number().int().min(1).max(20).default(5),
          offset: z.number().int().min(0).default(0),
        }),
      }),
      execute: async ({
        q,
        filters,
        sort,
        page,
      }: {
        q: string;
        filters?: {
          tags?: string[];
          price?: { min?: number; max?: number };
          inStockOnly?: boolean;
        };
        sort?: { field: "price" | "stock" | "relevance"; order: "asc" | "desc" };
        page: { limit: number; offset: number };
      }) => {
        let items = Object.values(db.inventory).map((item) => ({
          ...item,
          tags:
            item.sku === "umbrella"
              ? ["rain", "outdoor"]
              : item.sku === "sunscreen"
                ? ["sun", "outdoor"]
                : ["cold", "outdoor"],
        }));

        const qLower = q.toLowerCase();
        items = items.filter(
          (item) =>
            item.sku.includes(qLower) ||
            item.tags.some((tag) => tag.includes(qLower)) ||
            qLower.includes("rain") && item.sku === "umbrella" ||
            qLower.includes("hot") && item.sku === "sunscreen" ||
            qLower.includes("cold") && item.sku === "heat_pack" ||
            qLower.includes("weather")
        );

        if (filters?.inStockOnly) {
          items = items.filter((item) => item.stock > 0);
        }
        if (filters?.price?.min != null) {
          items = items.filter((item) => item.priceKrw >= filters.price!.min!);
        }
        if (filters?.price?.max != null) {
          items = items.filter((item) => item.priceKrw <= filters.price!.max!);
        }
        if (filters?.tags?.length) {
          items = items.filter((item) =>
            filters.tags!.some((tag) => item.tags.includes(tag))
          );
        }

        if (sort?.field === "price") {
          items.sort((a, b) =>
            sort.order === "asc"
              ? a.priceKrw - b.priceKrw
              : b.priceKrw - a.priceKrw
          );
        } else if (sort?.field === "stock") {
          items.sort((a, b) =>
            sort.order === "asc" ? a.stock - b.stock : b.stock - a.stock
          );
        }

        const sliced = items.slice(page.offset, page.offset + page.limit);
        return {
          total: items.length,
          page,
          items: sliced,
        };
      },
    },

    create_itinerary_plan: {
      description:
        "Create a structured itinerary plan from weather + product constraints. Requires nested activities array.",
      inputSchema: z.object({
        userId: z.string(),
        day: z.string(),
        city: z.string(),
        weatherSummary: z.object({
          temperature: z.number(),
          condition: z.string(),
          units: z.enum(["metric", "imperial"]),
        }),
        activities: z
          .array(
            z.object({
              name: z.string(),
              durationMinutes: z.number().int().positive(),
              outdoor: z.boolean(),
              requiredItems: z.array(z.string()).default([]),
            })
          )
          .min(1),
        budgetKrw: z.number().int().positive(),
      }),
      execute: async (input: {
        userId: string;
        day: string;
        city: string;
        weatherSummary: {
          temperature: number;
          condition: string;
          units: "metric" | "imperial";
        };
        activities: Array<{
          name: string;
          durationMinutes: number;
          outdoor: boolean;
          requiredItems: string[];
        }>;
        budgetKrw: number;
      }) => {
        const required = [
          ...new Set(input.activities.flatMap((a) => a.requiredItems)),
        ];
        const estimatedCost = required.reduce((sum, sku) => {
          const item = db.inventory[sku as keyof typeof db.inventory];
          return sum + (item?.priceKrw ?? 0);
        }, 0);
        return {
          planId: `plan_${input.userId}_${input.day}`,
          city: input.city,
          feasible: estimatedCost <= input.budgetKrw,
          estimatedCostKrw: estimatedCost,
          requiredItems: required,
          activities: input.activities,
          notes:
            input.weatherSummary.condition === "humid"
              ? "Prefer shade and hydration."
              : "Good day for outdoor blocks.",
        };
      },
    },
  };
}

const PROMPT = `You are an agent for a Korean outdoor day planner.

Task for user "Kim" (not Lee):
1) Resolve the user profile by display name.
2) Using the profile home city and preferred units, fetch a weather bundle for that city and also Incheon. Request fields temperature, condition, humidity. includeHourly=false.
3) Based on weather, search the catalog for relevant outdoor gear (e.g. rain/sun/cold) with inStockOnly=true, sort by price asc, limit 3.
4) Create an itinerary plan for day=2026-08-09 in the home city with at least 2 activities (one outdoor). budgetKrw=50000. Include weatherSummary from the tool results and requiredItems from catalog SKUs when useful.
5) Finally write a short Korean summary for the user (2-4 sentences) with temperature and one product suggestion.

Rules:
- Use tools; do not invent tool results.
- Prefer multiple tool steps over guessing.
- Keep final answer concise Korean.`;

function callsNamed(traces: ToolCallTrace[], name: string) {
  return traces.filter((t) => t.toolName === name);
}

function evaluate(traces: ToolCallTrace[], text: string) {
  const names = traces.map((t) => t.toolName);
  const has = (name: string) => names.includes(name);

  const profileInputs = callsNamed(traces, "resolve_user_profile").map((t) =>
    JSON.stringify(t.input ?? {})
  );
  const weatherInputs = callsNamed(traces, "get_weather_bundle").map(
    (t) =>
      t.input as
        | {
            locations?: Array<{ city?: string }>;
            options?: {
              units?: string;
              fields?: string[];
              includeHourly?: boolean;
            };
          }
        | undefined
  );
  const catalogInputs = callsNamed(traces, "search_catalog").map(
    (t) =>
      t.input as
        | {
            filters?: { inStockOnly?: boolean };
            sort?: { field?: string; order?: string };
            page?: { limit?: number };
          }
        | undefined
  );
  const planInputs = callsNamed(traces, "create_itinerary_plan").map(
    (t) =>
      t.input as
        | {
            userId?: string;
            city?: string;
            activities?: unknown[];
            weatherSummary?: { temperature?: number; condition?: string };
            budgetKrw?: number;
          }
        | undefined
  );

  const allCities = weatherInputs.flatMap((input) =>
    (input?.locations ?? []).map((l) => String(l.city ?? "").toLowerCase())
  );

  return {
    usedProfile: has("resolve_user_profile"),
    usedWeather: has("get_weather_bundle"),
    usedCatalog: has("search_catalog"),
    usedPlan: has("create_itinerary_plan"),
    multiStep: new Set(traces.map((t) => t.step)).size >= 2,
    atLeast3Tools: new Set(names).size >= 3,
    profileMentionsKim: profileInputs.some(
      (input) => /kim/i.test(input) || /u_kim/i.test(input)
    ),
    weatherHasSeoul: allCities.some((c) => c.includes("seoul")),
    weatherHasIncheon: allCities.some((c) => c.includes("incheon")),
    weatherMultiLocation: weatherInputs.some(
      (input) => (input?.locations?.length ?? 0) >= 2
    ),
    weatherNestedOptions: weatherInputs.some(
      (input) => Boolean(input?.options?.units && input?.options?.fields)
    ),
    catalogInStock: catalogInputs.some(
      (input) => input?.filters?.inStockOnly === true
    ),
    catalogSorted: catalogInputs.some(
      (input) =>
        input?.sort?.field === "price" && input?.sort?.order === "asc"
    ),
    planHasActivities: planInputs.some(
      (input) => (input?.activities?.length ?? 0) >= 2
    ),
    planHasWeatherSummary: planInputs.some((input) =>
      Boolean(input?.weatherSummary?.temperature)
    ),
    finalKorean: /[가-힣]/.test(text),
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
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      stopWhen: stepCountIs(MAX_STEPS),
      providerOptions: providerOptions(),
      system:
        "You are a careful tool-using agent. Follow the tool schemas exactly. Nested objects/arrays must be filled properly.",
      prompt: PROMPT,
      tools: buildTools(),
    });

    const traces: ToolCallTrace[] = [];
    result.steps.forEach((step, stepIndex) => {
      for (const call of step.toolCalls ?? []) {
        traces.push({
          step: stepIndex + 1,
          toolName: call.toolName,
          input: call.input,
        });
      }
    });

    const text = result.text ?? "";
    const checks = evaluate(traces, text);
    const required = [
      checks.usedProfile,
      checks.usedWeather,
      checks.usedCatalog,
      checks.usedPlan,
      checks.multiStep,
      checks.weatherNestedOptions,
      checks.planHasActivities,
      checks.finalKorean,
    ];
    const ok = required.every(Boolean);

    return {
      path,
      ok,
      wallMs: performance.now() - t0,
      steps: result.steps.length,
      toolCalls: traces.length,
      uniqueTools: [...new Set(traces.map((t) => t.toolName))],
      toolNames: traces.map((t) => t.toolName),
      finishReasons: result.steps.map((s) => String(s.finishReason)),
      text,
      traces,
      checks,
    };
  } catch (error) {
    return {
      path,
      ok: false,
      wallMs: performance.now() - t0,
      steps: 0,
      toolCalls: 0,
      uniqueTools: [],
      toolNames: [],
      finishReasons: [],
      text: "",
      traces: [],
      checks: {},
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
  return {
    n: values.length,
    mean,
    p50: sorted[Math.floor((sorted.length - 1) / 2)] ?? 0,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function printRun(label: string, row: RunMetrics) {
  console.log(`\n### ${label}`);
  console.log(
    `ok=${row.ok} wall=${row.wallMs.toFixed(0)}ms steps=${row.steps} tools=${row.toolCalls} unique=[${row.uniqueTools.join(",")}]`
  );
  console.log(`finish=[${row.finishReasons.join(" -> ")}]`);
  console.log(`tool sequence: ${row.toolNames.join(" -> ") || "(none)"}`);
  if (row.error) {
    console.log(`error: ${row.error.slice(0, 300)}`);
  }
  console.log("checks:", JSON.stringify(row.checks, null, 2));
  console.log("traces:");
  for (const trace of row.traces) {
    console.log(
      `  step ${trace.step} ${trace.toolName} ${JSON.stringify(trace.input)}`
    );
  }
  console.log(`final text: ${row.text.slice(0, 400)}`);
}

async function main() {
  console.log("K-EXAONE-2.0 complex agentic bench");
  console.log(
    JSON.stringify(
      {
        model: MODEL,
        runs: RUNS,
        enableThinking: ENABLE_THINKING,
        maxSteps: MAX_STEPS,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
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
    console.log(`\n===== RUN ${i + 1}/${RUNS} native =====`);
    const native = await runOnce("native");
    nativeRows.push(native);
    printRun(`native #${i + 1}`, native);

    console.log(`\n===== RUN ${i + 1}/${RUNS} middleware =====`);
    const mw = await runOnce("middleware");
    mwRows.push(mw);
    printRun(`middleware #${i + 1}`, mw);
  }

  const summarize = (name: string, rows: RunMetrics[]) => {
    const ok = rows.filter((r) => r.ok);
    const s = stats(ok.map((r) => r.wallMs));
    const toolMean =
      rows.reduce((a, r) => a + r.toolCalls, 0) / Math.max(rows.length, 1);
    const stepMean =
      rows.reduce((a, r) => a + r.steps, 0) / Math.max(rows.length, 1);
    console.log(`\n## ${name}`);
    console.log(
      `success ${ok.length}/${rows.length} | tools/run=${toolMean.toFixed(2)} steps/run=${stepMean.toFixed(2)}`
    );
    if (ok.length) {
      console.log(
        `wallMs mean=${s.mean.toFixed(0)} p50=${s.p50.toFixed(0)} min=${s.min.toFixed(0)} max=${s.max.toFixed(0)}`
      );
    }
    const checkKeys = new Set(rows.flatMap((r) => Object.keys(r.checks)));
    for (const key of [...checkKeys].sort()) {
      const pass = rows.filter((r) => r.checks[key]).length;
      console.log(`  check ${key}: ${pass}/${rows.length}`);
    }
  };

  summarize("native tools API", nativeRows);
  summarize("kExaone2ToolMiddleware", mwRows);

  const n = stats(nativeRows.filter((r) => r.ok).map((r) => r.wallMs));
  const m = stats(mwRows.filter((r) => r.ok).map((r) => r.wallMs));
  console.log("\n## comparison");
  console.log(
    `native success ${nativeRows.filter((r) => r.ok).length}/${nativeRows.length}`
  );
  console.log(
    `middleware success ${mwRows.filter((r) => r.ok).length}/${mwRows.length}`
  );
  if (n.n && m.n) {
    const delta = m.mean - n.mean;
    const pct = (delta / n.mean) * 100;
    console.log(
      `wall mean native=${n.mean.toFixed(0)}ms middleware=${m.mean.toFixed(0)}ms delta=${delta.toFixed(0)}ms (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`
    );
  } else {
    console.log("insufficient successful runs for latency comparison");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
