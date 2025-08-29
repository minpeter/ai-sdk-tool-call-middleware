import { hermesToolMiddleware } from "@ai-sdk-tool/parser";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, wrapLanguageModel } from "ai";
import { z } from "zod";

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
      model: friendli.chat("meta-llama/Llama-3.1-8B-Instruct"),
      middleware: hermesToolMiddleware,
    }),
    tools: {
      weather: {
        description: "Get the weather in a location",
        inputSchema: z.object({
          location: z.string().describe("The location to get the weather for"),
        }),
        execute: async ({ location }) => ({
          location,
          temperature: 72 + Math.floor(Math.random() * 21) - 10,
        }),
      },
      currencyConverter: {
        description: "Convert an amount from one currency to another",
        inputSchema: z.object({
          amount: z.number().describe("The amount of money to convert"),
          from: z.string().describe("The currency code to convert from"),
          to: z.string().describe("The currency code to convert to"),
        }),
        execute: async ({ amount, from, to }) => ({
          convertedAmount: amount * 1.1, // Dummy conversion rate
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
