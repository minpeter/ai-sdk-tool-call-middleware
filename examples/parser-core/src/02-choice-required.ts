import { createOpenAI } from "@ai-sdk/openai";
import { hermesToolMiddleware } from "@ai-sdk-tool/parser";
import { generateText, wrapLanguageModel } from "ai";
import { z } from "zod";

// Constants
const BASE_TEMPERATURE = 72;
const TEMPERATURE_RANGE = 21;
const TEMPERATURE_OFFSET = 10;
const CONVERSION_RATE = 1.1;

const openrouter = createOpenAI({
  name: "openrouter",
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

async function main() {
  const result = await generateText({
    model: wrapLanguageModel({
      model: openrouter.chat("xiaomi/mimo-v2-flash:free"),
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
      currencyConverter: {
        description: "Convert an amount from one currency to another",
        inputSchema: z.object({
          amount: z.number().describe("The amount of money to convert"),
          from: z.string().describe("The currency code to convert from"),
          to: z.string().describe("The currency code to convert to"),
        }),
        execute: ({ amount, from, to }) => ({
          convertedAmount: amount * CONVERSION_RATE, // Dummy conversion rate
          from,
          to,
        }),
      },
    },
    toolChoice: "required",
    prompt: "Tell me a joke about programming", // inrrelevant to the tool
  });

  console.log(
    JSON.stringify(
      {
        finishReason: result.finishReason,
        content: result.content,
      },
      null,
      2
    )
  );
}

main().catch(console.error);
