import fs from "node:fs";
import path from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  bfclSimpleBenchmark,
  evaluate,
  type ReporterType,
} from "@ai-sdk-tool/eval";
import { createToolMiddleware, xmlProtocol } from "@ai-sdk-tool/parser";
import { extractReasoningMiddleware, wrapLanguageModel } from "ai";

// Load system prompt from file
const systemPromptPath = path.join(
  __dirname,
  "Llama-4-Maverick-morphXml-bfcl.txt"
);
const systemPromptTemplate = fs.readFileSync(systemPromptPath, "utf-8");

// Create custom middleware with loaded system prompt
const customMorphXmlMiddleware = createToolMiddleware({
  protocol: xmlProtocol,
  placement: "last",
  toolSystemPromptTemplate(tools: string) {
    return systemPromptTemplate.replace(/\$\{tools\}/g, tools);
  },
});

// Friendli API
const friendli = createOpenAICompatible({
  name: "friendli.serverless",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
});

// Test MiniMax-M2
const minimaxBase = friendli("MiniMaxAI/MiniMax-M2");

// Try with reasoning middleware (like 01-stream-reasoning-tool-call.ts)
const minimaxWithReasoning = wrapLanguageModel({
  model: minimaxBase,
  middleware: [
    customMorphXmlMiddleware,
    extractReasoningMiddleware({ tagName: "think" }),
  ],
});

async function main() {
  console.log("🔍 Deep Dive: MiniMax-M2 Debug\n");
  console.log("Testing with reasoning middleware...\n");

  const reporterEnv = process.env.EVAL_REPORTER as ReporterType | undefined;

  await evaluate({
    models: {
      "minimax-m2-with-reasoning": minimaxWithReasoning,
    },
    benchmarks: [bfclSimpleBenchmark],
    reporter: reporterEnv ?? "console",
    temperature: 0.0,
    maxTokens: 512, // Increase token limit to see full output
  });

  console.log("\nDebug complete!");
}

main();
