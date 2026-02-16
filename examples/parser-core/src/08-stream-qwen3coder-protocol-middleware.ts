/**
 * Example: Streaming tool calls with qwen3CoderToolParserMiddleware
 *
 * Uses streamText + wrapLanguageModel to enable text-based tool calling
 * for models served via OpenAI-compatible endpoints (vLLM, OpenRouter, etc.)
 *
 * Run:
 *   OPENROUTER_API_KEY=... pnpm dlx tsx src/08-stream-qwen3coder-protocol-middleware.ts
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { qwen3CoderToolParserMiddleware } from "@ai-sdk-tool/parser/community";
import { streamText, wrapLanguageModel } from "ai";
import { z } from "zod";

// ── Provider setup ──────────────────────────────────────
// Works with any OpenAI-compatible endpoint: vLLM, Ollama, OpenRouter, etc.
const provider = createOpenAICompatible({
  name: "openrouter",
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

// Wrap the model with the middleware — this converts native tool calls
// to text-based <tool_call> XML format via system prompt injection.
const model = wrapLanguageModel({
  model: provider("qwen/qwen3-coder"),
  middleware: qwen3CoderToolParserMiddleware,
});

// ── Tools ───────────────────────────────────────────────
const tools = {
  get_weather: {
    description: "Get the current weather for a given city.",
    parameters: z.object({
      city: z.string().describe("City name"),
      unit: z
        .enum(["celsius", "fahrenheit"])
        .optional()
        .describe("Temperature unit"),
    }),
    execute: async ({ city, unit }: { city: string; unit?: string }) => ({
      city,
      temperature: 18 + Math.floor(Math.random() * 15),
      unit: unit ?? "celsius",
      condition: ["sunny", "cloudy", "rainy"][Math.floor(Math.random() * 3)],
    }),
  },
  calculator: {
    description: "Evaluate a math expression.",
    parameters: z.object({
      expression: z.string().describe("Math expression to evaluate"),
    }),
    execute: ({ expression }: { expression: string }) => {
      try {
        // Simple eval for demo only — don't do this in production!
        return {
          expression,
          result: Function(`"use strict"; return (${expression})`)(),
        };
      } catch {
        return { expression, error: "Invalid expression" };
      }
    },
  },
};

// ── Stream ──────────────────────────────────────────────
async function main() {
  const result = streamText({
    model,
    tools,
    prompt: "What's the weather in Seoul and Tokyo? Also, what's 42 * 58?",
    maxSteps: 5, // allow multi-turn tool use
  });

  // Print events as they arrive
  process.stdout.write("\n");

  for await (const part of result.fullStream) {
    switch (part.type) {
      case "text-delta":
        process.stdout.write(part.textDelta);
        break;

      case "tool-call-streaming-start":
        console.log(`\n🔧 [tool-input-start] ${part.toolName}`);
        break;

      case "tool-call-delta":
        process.stdout.write(`  Δ ${part.argsTextDelta}\n`);
        break;

      case "tool-call":
        console.log(
          `✅ [tool-call] ${part.toolName}(${JSON.stringify(part.args)})`
        );
        break;

      case "tool-result":
        console.log(`📦 [tool-result] ${JSON.stringify(part.result)}`);
        break;

      case "step-finish":
        console.log(`── step done (${part.finishReason}) ──`);
        break;

      default:
        break;
    }
  }

  // Final usage
  const usage = await result.usage;
  console.log(
    `\n📊 Tokens: ${usage.promptTokens} in / ${usage.completionTokens} out`
  );
}

main().catch(console.error);
