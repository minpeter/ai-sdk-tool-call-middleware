import fs from "node:fs";
import path from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createToolMiddleware, xmlProtocol } from "@ai-sdk-tool/parser";
import { extractReasoningMiddleware, wrapLanguageModel } from "ai";

// Load system prompt
const systemPromptPath = path.join(
  __dirname,
  "Llama-4-Maverick-morphXml-bfcl.txt"
);
const systemPromptTemplate = fs.readFileSync(systemPromptPath, "utf-8");

const customMorphXmlMiddleware = createToolMiddleware({
  protocol: xmlProtocol,
  placement: "last",
  toolSystemPromptTemplate(tools) {
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

// GLM-4.6
const _glm = wrapLanguageModel({
  model: friendli("zai-org/GLM-4.6"),
  middleware: [
    customMorphXmlMiddleware,
    extractReasoningMiddleware({ tagName: "think" }),
  ],
});

// Load failed cases
const failedCases = JSON.parse(
  fs.readFileSync("bfcl-failed-cases.json", "utf-8")
);

function debugFailedCase(caseId: string) {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`DEBUGGING FAILED CASE: ${caseId}`);
  console.log("=".repeat(80));

  // Load test case from BFCL data
  const dataPath = path.join(__dirname, "../../../packages/eval/data");

  let testCase: unknown;
  try {
    const bfclData = fs.readFileSync(
      path.join(dataPath, "BFCL_v3_simple.jsonl"),
      "utf-8"
    );
    const lines = bfclData.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      const data = JSON.parse(line);
      if (data.id === caseId) {
        testCase = data;
        break;
      }
    }
  } catch (e) {
    console.log("Error loading test case:", e);
    return;
  }

  if (!testCase) {
    console.log(`❌ Test case ${caseId} not found`);
    return;
  }

  // Type assertion after null check
  const typedTestCase = testCase as {
    id: string;
    question: Array<{ content: string }>;
    function: unknown[];
  };

  console.log(`\nTest Case: ${typedTestCase.id}`);
  console.log(
    `Question: ${typedTestCase.question[0].content.slice(0, 200)}...`
  );
  console.log(`\nAvailable tools: ${typedTestCase.function.length}`);

  // This is just a framework - full implementation would require:
  // 1. Building tools from testCase.function
  // 2. Running generateText with DEBUG_PARSER_OUTPUT=true
  // 3. Analyzing the raw XML output

  console.log(
    "\n⏳ To fully debug, we need to re-implement tool building logic here"
  );
  console.log("   or use the evaluate() function with DEBUG mode");
}

async function main() {
  console.log("🔍 Debugging Failed BFCL Cases\n");

  // Debug first 3 simple failures
  console.log("Analyzing first 3 simple failures...\n");

  for (const caseId of failedCases.simple.slice(0, 3)) {
    await debugFailedCase(caseId);
  }

  console.log(`\n${"=".repeat(80)}`);
  console.log("ANALYSIS COMPLETE");
  console.log("=".repeat(80));
}

main();
