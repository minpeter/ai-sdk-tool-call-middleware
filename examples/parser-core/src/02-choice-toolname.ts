import { createOpenAI } from "@ai-sdk/openai";
import { hermesToolMiddleware } from "@ai-sdk-tool/parser";
import { generateText, wrapLanguageModel } from "ai";
import { z } from "zod";

// Constants
const BASE_TEMPERATURE = 72;
const TEMPERATURE_RANGE = 21;
const TEMPERATURE_OFFSET = 10;

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
      model: friendli.chat("Qwen/Qwen3-32B"),
      middleware: hermesToolMiddleware,
    }),
    tools: {
      weather: {
        description: "Get the weather in a location",
        inputSchema: z.object({
          location: z.string().describe("The location to get the weather for"),
        }),
        execute: ({ location }) => ({
          location,
          temperature:
            BASE_TEMPERATURE +
            Math.floor(Math.random() * TEMPERATURE_RANGE) -
            TEMPERATURE_OFFSET,
        }),
      },
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
