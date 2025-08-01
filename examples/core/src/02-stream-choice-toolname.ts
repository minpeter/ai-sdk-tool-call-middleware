import { z } from "zod";
import { streamText, tool, wrapLanguageModel } from "ai";
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
    },
    toolChoice: { type: "tool", toolName: "weather" },
    prompt: "Tell me a joke about programming", // inrrelevant to the tool
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
