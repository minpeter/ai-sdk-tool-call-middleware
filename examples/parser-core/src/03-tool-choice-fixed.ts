import { createOpenAI } from "@ai-sdk/openai";
import { generateText, wrapLanguageModel } from "ai";
import { z } from "zod";
import { morphXmlToolMiddleware } from "../../../src/preconfigured-middleware";
import { printComplete, printStepLikeStream } from "./console-output";

// Constants
const BASE_TEMPERATURE = 72;
const TEMPERATURE_RANGE = 21;
const TEMPERATURE_OFFSET = 10;

const openrouter = createOpenAI({
  name: "openrouter",
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

async function main() {
  await generateText({
    model: wrapLanguageModel({
      model: openrouter.chat("arcee-ai/trinity-large-preview:free"),
      middleware: morphXmlToolMiddleware,
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
    onStepFinish: (step) => {
      printStepLikeStream(step);
    },
  });

  printComplete();
}

main().catch(console.error);
