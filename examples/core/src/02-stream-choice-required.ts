import { z } from "zod";
import { stepCountIs, streamText, tool, wrapLanguageModel } from "ai";
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
  const result = streamText({
    model: wrapLanguageModel({
      // NOTE: All models of friendli serverless are supported by the tool, but can be overridden via middleware.
      model: friendli("meta-llama-3.1-8b-instruct"),
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
    stopWhen: stepCountIs(4), // Keep calling tools only because of required
    prompt: "Tell me a joke about programming", // inrrelevant to the tool,
  });

  for await (const part of result.fullStream) {
    if (part.type === "text") {
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
