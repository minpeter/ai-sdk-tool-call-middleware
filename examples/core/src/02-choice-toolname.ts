import { z } from "zod";
import { generateText, tool, wrapLanguageModel } from "ai";
import { hermesToolMiddleware } from "@ai-sdk-tool/parser";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

// A provider with supportsStructuredOutputs: true is required. Investigating....
// createOpenAICompatible cannot be used here.
const friendli = createOpenAI({
  name: "friendli",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
});

async function main() {
  const result = await generateText({
    model: wrapLanguageModel({
      // NOTE: All models of friendli serverless are supported by the tool, but can be overridden via middleware.
      model: friendli("meta-llama-3.1-8b-instruct"),
      middleware: hermesToolMiddleware,
    }),
    tools: {
      weather: tool({
        description: "Get the weather in a location",
        parameters: z.object({
          location: z.string().describe("The location to get the weather for"),
        }),
        execute: async ({ location }) => ({
          location,
          temperature: 72 + Math.floor(Math.random() * 21) - 10,
        }),
      }),
    },
    toolChoice: { type: "tool", toolName: "weather" },
    prompt: "Tell me a joke about programming", // inrrelevant to the tool
  });

  console.log(JSON.stringify(result, null, 2));
  console.log({
    finishReason: result.finishReason,
    content: result.content,
  });
}

main().catch(console.error);
