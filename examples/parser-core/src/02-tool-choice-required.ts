import { createOpenAI } from "@ai-sdk/openai";
import { generateText, wrapLanguageModel } from "ai";
import { z } from "zod";
import { qwen3CoderToolMiddleware } from "../../../src/preconfigured-middleware";
import { printComplete, printStepLikeStream } from "./console-output";

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
  await generateText({
    model: wrapLanguageModel({
      model: openrouter.chat("stepfun/step-3.5-flash:free"),
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
    onStepFinish: (step) => {
      printStepLikeStream(step);
    },
  });

  printComplete();
}

main().catch(console.error);
