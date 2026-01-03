import fs from "node:fs";
import path from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  complexFuncBenchBenchmark,
  evaluate,
  type ReporterType,
} from "@ai-sdk-tool/eval";
import {
  createToolMiddleware,
  type TCMToolDefinition,
  xmlProtocol,
} from "@ai-sdk-tool/parser";
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
  toolSystemPromptTemplate(tools: TCMToolDefinition[]) {
    const toolsString = JSON.stringify(tools);
    return systemPromptTemplate.replace(/\$\{tools\}/g, toolsString);
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
  console.log("🔥 ComplexFuncBench: Testing GLM-4.6 (ALL 1000 CASES)\n");
  console.log("This comprehensive test will:");
  console.log("  - Test all 1000 complex function calling scenarios");
  console.log("  - Identify failure patterns");
  console.log("  - Help classify parser vs model issues\n");

  const reporterEnv = process.env.EVAL_REPORTER as ReporterType | undefined;

  // Note: Do NOT set COMPLEXFUNCBENCH_LIMIT - test all 1000 cases
  console.log("Starting evaluation... (this may take 15-30 minutes)\n");

  const startTime = Date.now();

  await evaluate({
    models: {
      "glm-4.6": glm,
    },
    benchmarks: [complexFuncBenchBenchmark],
    reporter: reporterEnv ?? "console",
    temperature: 0.0,
    maxTokens: 1024,
  });

  const duration = Math.round((Date.now() - startTime) / 1000);
  console.log(
    `\n✅ ComplexFuncBench evaluation complete! (${duration}s total)`
  );
}

main();
