import { createOpenAI } from "@ai-sdk/openai";
import { streamText, wrapLanguageModel } from "ai";
import { z } from "zod";
import { qwen3CoderToolMiddleware } from "../../../src/preconfigured-middleware";

const BASE_TEMPERATURE = 72;
const TEMPERATURE_RANGE = 21;
const TEMPERATURE_OFFSET = 10;

const openrouter = createOpenAI({
  name: "openrouter",
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

async function main() {
  const result = streamText({
    model: wrapLanguageModel({
      model: openrouter.chat("arcee-ai/trinity-large-preview:free"),
      middleware: qwen3CoderToolMiddleware,
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

  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      process.stdout.write(part.text);
    } else if (part.type === "tool-result") {
      console.log({
        name: part.toolName,
        input: part.input,
        output: part.output,
      });
    }
  }

  console.log("\n\n<Complete>");
}

main().catch(console.error);
