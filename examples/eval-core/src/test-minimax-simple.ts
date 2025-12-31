import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { z } from "zod";

const friendli = createOpenAICompatible({
  name: "friendli.serverless",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
});

async function testNativeToolCalling() {
  console.log("🧪 Testing MiniMax-M2 Native Tool Calling Support\n");

  try {
    const result = await generateText({
      model: friendli("MiniMaxAI/MiniMax-M2"),
      prompt: "What is 5 factorial?",
      tools: {
        calculate_factorial: {
          description: "Calculate factorial of a number",
          // @ts-expect-error - simplified tool definition format for testing
          parameters: z.object({
            number: z.number().describe("The number to calculate factorial"),
          }),
        },
      },
      maxTokens: 256,
    });

    console.log("✅ Success!");
    console.log("\nFull Text:", result.text);
    console.log("\nTool Calls:", result.toolCalls);
    console.log("\nFinish Reason:", result.finishReason);
    console.log("\nRaw Response:", JSON.stringify(result.response, null, 2));
  } catch (error) {
    console.log("❌ Error:", error);
  }
}

async function testWithExplicitSystemPrompt() {
  console.log("\n\n🧪 Testing with Explicit Tool Call Instructions\n");

  try {
    const result = await generateText({
      model: friendli("MiniMaxAI/MiniMax-M2"),
      system: `You are a helpful assistant that MUST use the provided tools to answer questions.

CRITICAL: When a tool is available, you MUST call it using XML format:
<tool_name>
  <parameter_name>value</parameter_name>
</tool_name>

DO NOT answer directly. ALWAYS use the tool when available.`,
      prompt: "Calculate 5 factorial using the calculate_factorial tool.",
      tools: {
        calculate_factorial: {
          description: "Calculate factorial of a number",
          // @ts-expect-error - simplified tool definition format for testing
          parameters: z.object({
            number: z.number().describe("The number to calculate factorial"),
          }),
        },
      },
      maxTokens: 256,
    });

    console.log("Full Text:", result.text);
    console.log("\nTool Calls:", result.toolCalls);
    console.log("\nFinish Reason:", result.finishReason);
  } catch (error) {
    console.log("Error:", error);
  }
}

async function main() {
  await testNativeToolCalling();
  await testWithExplicitSystemPrompt();
}

main();
