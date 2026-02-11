import { createOpenAI } from "@ai-sdk/openai";
import { streamText, wrapLanguageModel } from "ai";
import { z } from "zod";
import {
  xmlToolMiddleware,
  yamlToolMiddleware,
} from "../src/preconfigured-middleware";

type AnyPart = Record<string, unknown>;

const modelId = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  throw new Error("OPENAI_API_KEY is required");
}

const openai = createOpenAI({ apiKey });

const tools = {
  get_weather: {
    description: "Get weather for a city",
    inputSchema: z.object({
      location: z.string(),
      unit: z.enum(["celsius", "fahrenheit"]),
    }),
  },
};

const prompt = [
  "Call the get_weather tool exactly once.",
  'Use arguments exactly: {"location":"Seoul","unit":"celsius"}.',
  "Do not output any normal text before the tool call.",
].join("\n");

const scenarios: Array<{
  name: string;
  model: ReturnType<typeof openai.chat>;
  toolChoice?: "required";
}> = [
  {
    name: "Native OpenAI tool-calling",
    model: openai.chat(modelId),
    toolChoice: "required",
  },
  {
    name: "OpenAI + xmlToolMiddleware",
    model: wrapLanguageModel({
      model: openai.chat(modelId),
      middleware: xmlToolMiddleware,
    }) as ReturnType<typeof openai.chat>,
  },
  {
    name: "OpenAI + yamlToolMiddleware",
    model: wrapLanguageModel({
      model: openai.chat(modelId),
      middleware: yamlToolMiddleware,
    }) as ReturnType<typeof openai.chat>,
  },
];

function short(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 140 ? `${value.slice(0, 137)}...` : value;
  }
  return value;
}

function compactPart(part: AnyPart): Record<string, unknown> {
  const keys = [
    "type",
    "id",
    "toolCallId",
    "toolName",
    "name",
    "delta",
    "text",
    "input",
    "argsTextDelta",
    "arguments",
    "finishReason",
  ];

  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in part && part[key] != null) {
      out[key] = short(part[key]);
    }
  }

  if (Object.keys(out).length === 0) {
    out.type = (part.type as string) ?? "unknown";
  }
  return out;
}

function summarize(name: string, parts: AnyPart[]): void {
  const typeCounts = new Map<string, number>();
  for (const part of parts) {
    const type = String(part.type ?? "unknown");
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  }

  const toolInputDeltas = parts
    .filter((part) => part.type === "tool-input-delta")
    .map((part) => String(part.delta ?? ""));

  const toolCall = [...parts]
    .reverse()
    .find((part) => part.type === "tool-call") as
    | { input?: string; toolName?: string; toolCallId?: string }
    | undefined;

  const nativeArgDeltas = parts.filter((part) => {
    const type = String(part.type ?? "");
    return type.includes("tool-call") && type.includes("delta");
  });

  console.log(`\n=== ${name} ===`);
  console.log("Type counts:", Object.fromEntries(typeCounts.entries()));
  console.log(
    "Has tool-input-delta:",
    parts.some((part) => part.type === "tool-input-delta")
  );
  console.log("Native-like tool-call delta parts:", nativeArgDeltas.length);
  if (toolInputDeltas.length > 0) {
    console.log("Joined tool-input-delta:", toolInputDeltas.join(""));
  }
  if (toolCall) {
    console.log("Final tool-call:", {
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      input: short(toolCall.input),
    });
  }

  console.log("Parts:");
  parts.forEach((part, index) => {
    console.log(`${String(index + 1).padStart(2, "0")}.`, compactPart(part));
  });
}

async function runScenario(
  scenario: (typeof scenarios)[number]
): Promise<AnyPart[]> {
  const result = streamText({
    model: scenario.model,
    prompt,
    tools,
    temperature: 0,
    ...(scenario.toolChoice ? { toolChoice: scenario.toolChoice } : {}),
  });

  const parts: AnyPart[] = [];
  for await (const part of result.fullStream) {
    parts.push(part as AnyPart);
  }
  return parts;
}

async function main() {
  console.log(`Model: ${modelId}`);
  console.log("Prompt:", prompt.replace(/\n/g, " | "));

  for (const scenario of scenarios) {
    const parts = await runScenario(scenario);
    summarize(scenario.name, parts);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
