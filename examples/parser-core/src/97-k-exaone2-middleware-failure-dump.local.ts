import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
  LanguageModelV4Content,
  LanguageModelV4Middleware,
} from "@ai-sdk/provider";
import { generateText, stepCountIs, wrapLanguageModel } from "ai";
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import {
  kExaone2Protocol,
  kExaone2ToolMiddleware,
} from "../../../src/index";

const MODEL = process.env.MODEL ?? "LGAI-EXAONE/K-EXAONE-2.0-750B-A37B";
const ENABLE_THINKING = process.env.ENABLE_THINKING === "true";
const MAX_STEPS = Number(process.env.MAX_STEPS ?? "8");
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS ?? "1000");
const API_KEY = process.env.FRIENDLI_API_KEY;
const BASE_URL =
  process.env.FRIENDLI_BASE_URL ?? "https://api.friendli.ai/serverless/v1";
const OUT_DIR = process.env.OUT_DIR ?? "/tmp/k-exaone2-failure-dump";

if (!API_KEY) {
  console.error("FRIENDLI_API_KEY is required");
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

const friendli = createOpenAICompatible({
  name: "friendli",
  apiKey: API_KEY,
  baseURL: BASE_URL,
});

interface CaptureStep {
  step: number;
  wallMs: number;
  finishReason?: string;
  rawContent: LanguageModelV4Content[];
  rawText: string;
  parsedContent: LanguageModelV4Content[];
  parsedToolCalls: Array<{
    toolName: string;
    input: string;
    empty: boolean;
  }>;
  protocolDirectParse: LanguageModelV4Content[];
  notes: string[];
}

const captures: CaptureStep[] = [];
let stepCounter = 0;

function contentToText(content: LanguageModelV4Content[]): string {
  return content
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      if (part.type === "reasoning") {
        return `[reasoning]${part.text}[/reasoning]`;
      }
      if (part.type === "tool-call") {
        return `[tool-call ${part.toolName} ${part.input}]`;
      }
      return `[${part.type}]`;
    })
    .join("\n");
}

function isEmptyInput(input: string): boolean {
  const trimmed = input.trim();
  return (
    trimmed === "" ||
    trimmed === "{}" ||
    trimmed === "null" ||
    trimmed === "undefined"
  );
}

const captureMiddleware: LanguageModelV4Middleware = {
  specificationVersion: "v4",
  wrapGenerate: async ({ doGenerate, params }) => {
    const step = ++stepCounter;
    const t0 = performance.now();
    const raw = await doGenerate();
    const wallMs = performance.now() - t0;

    const rawText = contentToText(raw.content ?? []);
    const notes: string[] = [];

    const tools = (
      params as {
        providerOptions?: {
          toolCallMiddleware?: { originalTools?: unknown };
        };
      }
    ).providerOptions?.toolCallMiddleware?.originalTools;

    const textParts = (raw.content ?? []).filter(
      (part): part is Extract<LanguageModelV4Content, { type: "text" }> =>
        part.type === "text"
    );
    const joinedText = textParts.map((part) => part.text).join("\n");

    if (textParts.length === 0) {
      notes.push("no-text-parts-in-raw-result");
    }
    if ((raw.content ?? []).some((part) => part.type === "tool-call")) {
      notes.push("provider-already-emitted-tool-call-parts");
    }

    const protocol = kExaone2Protocol();
    const protocolTools =
      (
        params as {
          tools?: Array<{
            type?: string;
            name?: string;
            description?: string;
            inputSchema?: unknown;
          }>;
        }
      ).tools?.filter((t) => t.type === "function" && t.name) ?? [];

    const appTools = (globalThis as { __KEXAONE_DEBUG_TOOLS__?: any }).__KEXAONE_DEBUG_TOOLS__ ?? [];

    const protocolDirectParse = protocol.parseGeneratedText({
      text: joinedText,
      tools: appTools,
    });

    const capture: CaptureStep = {
      step,
      wallMs,
      finishReason: String(raw.finishReason ?? ""),
      rawContent: raw.content ?? [],
      rawText: joinedText,
      parsedContent: [],
      parsedToolCalls: [],
      protocolDirectParse,
      notes,
    };
    captures.push(capture);

    console.log(`\n----- CAPTURE raw step ${step} (${wallMs.toFixed(0)}ms) -----`);
    console.log(`finishReason=${capture.finishReason}`);
    console.log(`raw text length=${joinedText.length}`);
    console.log(joinedText.length ? joinedText : "(empty raw text)");
    console.log(
      "protocolDirectParse:",
      JSON.stringify(
        protocolDirectParse.map((part) =>
          part.type === "tool-call"
            ? {
                type: part.type,
                toolName: part.toolName,
                input: part.input,
                empty: isEmptyInput(part.input),
              }
            : part.type === "text" || part.type === "reasoning"
              ? { type: part.type, text: part.text.slice(0, 200) }
              : { type: part.type }
        ),
        null,
        2
      )
    );

    return raw;
  },
};

const postParseCaptureMiddleware: LanguageModelV4Middleware = {
  specificationVersion: "v4",
  wrapGenerate: async ({ doGenerate }) => {
    const result = await doGenerate();
    const latest = captures[captures.length - 1];
    if (latest) {
      latest.parsedContent = result.content ?? [];
      latest.parsedToolCalls = (result.content ?? [])
        .filter(
          (
            part
          ): part is Extract<LanguageModelV4Content, { type: "tool-call" }> =>
            part.type === "tool-call"
        )
        .map((part) => ({
          toolName: part.toolName,
          input: part.input,
          empty: isEmptyInput(part.input),
        }));
      if (latest.parsedToolCalls.some((call) => call.empty)) {
        latest.notes.push("empty-tool-call-after-parse");
      }
      console.log(
        `----- CAPTURE parsed step ${latest.step} toolCalls=${latest.parsedToolCalls.length} -----`
      );
      console.log(JSON.stringify(latest.parsedToolCalls, null, 2));
      if (latest.notes.length) {
        console.log("notes:", latest.notes.join(", "));
      }
    }
    return result;
  },
};

const db = {
  users: {
    u_kim: {
      id: "u_kim",
      name: "Kim",
      homeCity: "Seoul",
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
          users.find((u) => normalize(u.name) === normalize(query.userId));
        if (!hit) {
          return {
            found: false as const,
            reason: "user_not_found",
            hint: 'Use query.displayName="Kim" or query.userId="u_kim".',
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
        "Fetch weather for one or more locations with nested options.",
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
              z.enum(["temperature", "condition", "humidity", "wind", "aqi"])
            )
            .default(["temperature", "condition"]),
        }),
      }),
      execute: async ({
        locations,
        options,
      }: {
        locations: Array<{ city: string }>;
        options: {
          units: "metric" | "imperial";
          includeHourly: boolean;
          fields: string[];
        };
      }) => ({
        units: options.units,
        results: locations.map((loc) => ({
          city: loc.city,
          temperature: loc.city.toLowerCase() === "seoul" ? 21 : 19,
          condition: "clear",
          humidity: 52,
        })),
      }),
    },
    search_catalog: {
      description: "Search product catalog with nested filters/sort/page.",
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
        filters?: { inStockOnly?: boolean; tags?: string[] };
        sort?: { field: string; order: string };
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
            qLower.includes("outdoor") ||
            qLower.includes("weather")
        );
        if (filters?.inStockOnly) {
          items = items.filter((item) => item.stock > 0);
        }
        if (sort?.field === "price") {
          items.sort((a, b) =>
            sort.order === "asc"
              ? a.priceKrw - b.priceKrw
              : b.priceKrw - a.priceKrw
          );
        }
        return {
          total: items.length,
          page,
          items: items.slice(page.offset, page.offset + page.limit),
        };
      },
    },
    create_itinerary_plan: {
      description: "Create itinerary plan from weather + activities.",
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
        activities: unknown[];
        budgetKrw: number;
      }) => ({
        planId: `plan_${input.userId}_${input.day}`,
        city: input.city,
        feasible: true,
        activities: input.activities,
        budgetKrw: input.budgetKrw,
      }),
    },
  };
}

const PROMPT = `You are an agent for a Korean outdoor day planner.

Task for user "Kim":
1) Resolve the user profile by display name.
2) Using the profile home city and preferred units, fetch a weather bundle for that city and also Incheon. Request fields temperature, condition, humidity. includeHourly=false.
3) Based on weather, search the catalog for relevant outdoor gear with inStockOnly=true, sort by price asc, limit 3.
4) Create an itinerary plan for day=2026-08-09 in the home city with at least 2 activities (one outdoor). budgetKrw=50000. Include weatherSummary from the tool results.
5) Finally write a short Korean summary.

Rules:
- Use tools; do not invent tool results.
- Never call a tool with empty arguments.
- Prefer multiple tool steps over guessing.`;

async function main() {
  const tools = buildTools();
  (globalThis as { __KEXAONE_DEBUG_TOOLS__?: unknown }).__KEXAONE_DEBUG_TOOLS__ =
    Object.entries(tools).map(([name, tool]) => ({
      type: "function",
      name,
      description: tool.description,
      inputSchema: { type: "object", properties: {} },
    }));

  const base = friendli.chatModel(MODEL);
  const withRawCapture = wrapLanguageModel({
    model: base,
    middleware: captureMiddleware,
  });
  const withParser = wrapLanguageModel({
    model: withRawCapture,
    middleware: kExaone2ToolMiddleware,
  });
  const model = wrapLanguageModel({
    model: withParser,
    middleware: postParseCaptureMiddleware,
  });

  console.log(
    JSON.stringify(
      {
        model: MODEL,
        enableThinking: ENABLE_THINKING,
        maxSteps: MAX_STEPS,
        outDir: OUT_DIR,
      },
      null,
      2
    )
  );

  const result = await generateText({
    model,
    temperature: 0,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    stopWhen: stepCountIs(MAX_STEPS),
    providerOptions: {
      friendli: {
        parse_reasoning: true,
        chat_template_kwargs: { enable_thinking: ENABLE_THINKING },
      },
    },
    system:
      "You are a careful tool-using agent. Follow tool schemas exactly. Nested objects/arrays must be valid. Never emit empty tool calls.",
    prompt: PROMPT,
    tools,
  });

  const emptySteps = captures.filter((c) =>
    c.parsedToolCalls.some((call) => call.empty)
  );
  const summary = {
    steps: result.steps.length,
    finishReasons: result.steps.map((s) => s.finishReason),
    toolSequence: result.steps.flatMap((s) =>
      (s.toolCalls ?? []).map((c) => c.toolName)
    ),
    finalText: result.text,
    captureCount: captures.length,
    emptyToolCallSteps: emptySteps.map((c) => c.step),
    captures: captures.map((c) => ({
      step: c.step,
      wallMs: c.wallMs,
      finishReason: c.finishReason,
      rawText: c.rawText,
      parsedToolCalls: c.parsedToolCalls,
      protocolDirectParse: c.protocolDirectParse.map((part) =>
        part.type === "tool-call"
          ? {
              type: "tool-call",
              toolName: part.toolName,
              input: part.input,
              empty: isEmptyInput(part.input),
            }
          : part.type === "text" || part.type === "reasoning"
            ? { type: part.type, text: part.text }
            : { type: part.type }
      ),
      notes: c.notes,
    })),
  };

  const outPath = `${OUT_DIR}/dump.json`;
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`\nWrote ${outPath}`);
  console.log(
    `empty tool-call steps: ${summary.emptyToolCallSteps.join(", ") || "(none)"}`
  );
  console.log(`final tool sequence: ${summary.toolSequence.join(" -> ")}`);
  console.log(`final text: ${(result.text ?? "").slice(0, 300)}`);

  for (const c of emptySteps) {
    console.log(`\n==== EMPTY TOOL CALL RAW DUMP step ${c.step} ====`);
    console.log(c.rawText);
    console.log("parsed:", JSON.stringify(c.parsedToolCalls, null, 2));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
