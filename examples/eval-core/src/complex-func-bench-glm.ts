import fs from "node:fs";
import path from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  complexFuncBenchBenchmark,
  evaluate,
  type ReporterType,
} from "@ai-sdk-tool/eval";
import { createToolMiddleware, morphXmlProtocol } from "@ai-sdk-tool/parser";
import { extractReasoningMiddleware, wrapLanguageModel } from "ai";

// Load system prompt from file
const systemPromptPath = path.join(
  __dirname,
  "Llama-4-Maverick-morphXml-bfcl.txt"
);
const systemPromptTemplate = fs.readFileSync(systemPromptPath, "utf-8");

// Create custom middleware with loaded system prompt
const customMorphXmlMiddleware = createToolMiddleware({
  protocol: morphXmlProtocol,
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

// GLM-4.6 with morphXML and reasoning extraction
const glm = wrapLanguageModel({
  model: friendli("zai-org/GLM-4.6"),
  middleware: [
    customMorphXmlMiddleware,
    extractReasoningMiddleware({ tagName: "think" }),
  ],
});

async function main() {
  console.log("🔥 ComplexFuncBench: Testing GLM-4.6\n");
  console.log("This benchmark includes:");
  console.log("  - Multi-step function calls");
  console.log("  - Function calling with constraints");
  console.log("  - Parameter value reasoning from implicit information");
  console.log("  - Long parameter values (500+ tokens)");
  console.log("  - Parallel function calls\n");

  const limitEnv = process.env.COMPLEXFUNCBENCH_LIMIT;
  const limit = limitEnv ? Number.parseInt(limitEnv, 10) : 50;
  console.log(
    `Testing with ${limit} cases (set COMPLEXFUNCBENCH_LIMIT to change)\n`
  );

  const reporterEnv = process.env.EVAL_REPORTER as ReporterType | undefined;

  await evaluate({
    models: {
      "glm-4.6": glm,
    },
    benchmarks: [complexFuncBenchBenchmark],
    reporter: reporterEnv ?? "console",
    temperature: 0.0,
    maxTokens: 1024, // Increased for complex scenarios
  });

  console.log("\n✅ ComplexFuncBench evaluation complete!");
}

main();
