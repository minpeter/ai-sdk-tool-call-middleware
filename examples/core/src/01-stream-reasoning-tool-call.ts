import { hermesToolMiddleware } from "@ai-sdk-tool/parser";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { extractReasoningMiddleware, streamText, wrapLanguageModel } from "ai";
import { z } from "zod";

const friendli = createOpenAICompatible({
  name: "friendli",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
});

async function main() {
  const result = streamText({
    model: wrapLanguageModel({
      model: friendli("deepseek-r1"),

      middleware: [
        // The order is important, extractReasoningMiddleware is called first and then hermesToolMiddleware,
        // because inside <think> the <tool_call> tag is created for reasoning and the tool call mode is triggered.
        hermesToolMiddleware,
        extractReasoningMiddleware({ tagName: "think" }),
      ],
    }),
    system: "You are a helpful assistant.",
    prompt: "What is the weather in my city?",
    maxSteps: 4,
    tools: {
      get_location: {
        description: "Get the User's location.",
        parameters: z.object({}),
        execute: async () => {
          // Simulate a location API call
          return {
            city: "New York",
            country: "USA",
          };
        },
      },
      get_weather: {
        description:
          "Get the weather for a given city. " +
          "Example cities: 'New York', 'Los Angeles', 'Paris'.",
        parameters: z.object({ city: z.string() }),
        execute: async ({ city }) => {
          // Simulate a weather API call
          const temperature = Math.floor(Math.random() * 100);
          return {
            city,
            temperature,
            condition: "sunny",
          };
        },
      },
    },
  });

  for await (const part of result.fullStream) {
    if (part.type === "text") {
      process.stdout.write(part.text);
    } else if (part.type === "reasoning") {
      // Print reasoning text in a different color (e.g., yellow)
      process.stdout.write(`\x1b[33m${part.text}\x1b[0m`);
    } else if (part.type === "tool-result") {
      console.log({
        name: part.toolName,
        args: part.args,
        result: part.result,
      });
    }
  }

  console.log("\n\n<Complete>");
}

main().catch(console.error);
