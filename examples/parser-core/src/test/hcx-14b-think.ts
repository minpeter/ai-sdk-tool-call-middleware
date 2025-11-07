import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { hermesToolMiddleware } from "@ai-sdk-tool/parser";
import { stepCountIs, streamText, wrapLanguageModel } from "ai";
import { z } from "zod";
import { extractReasoningMiddleware } from "./middleware/better-reasoning-middleware";

// Constants
const MAX_STEPS = 4;
const MAX_TEMPERATURE = 100;

const friendli = createOpenAICompatible({
  name: "friendli",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
  fetch: async (url, options) =>
    await fetch(url, {
      ...options,
      body: JSON.stringify({
        ...JSON.parse(options?.body as string),
        ...{
          parse_reasoning: false,
          chat_template_kwargs: {
            force_reasoning: true,
          },
        },
      }),
    }),
});

async function main() {
  const result = streamText({
    model: wrapLanguageModel({
      model: friendli("naver-hyperclovax/HyperCLOVAX-SEED-Think-14B"),
      middleware: [
        hermesToolMiddleware,
        extractReasoningMiddleware({
          openingTag: "/think\n",
          closingTag: "\nassistant\n",
          startWithReasoning: true,
        }),
      ],
    }),
    temperature: 0.5,
    prompt: "지금 내가 있는 위치의 날씨는 어떤가요?",
    stopWhen: stepCountIs(MAX_STEPS),
    tools: {
      get_location: {
        description: "Get the User's location.",
        inputSchema: z.object({}),
        execute: () => {
          // Simulate a location API call
          return {
            city: "Busan",
            country: "South Korea",
          };
        },
      },
      get_weather: {
        description:
          "Get the weather for a given city. " +
          "Example cities: 'New York', 'Los Angeles', 'Paris'.",
        inputSchema: z.object({ city: z.string() }),
        execute: ({ city }) => {
          // Simulate a weather API call
          const temperature = Math.floor(Math.random() * MAX_TEMPERATURE);
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
    if (part.type === "text-delta") {
      process.stdout.write(part.text);
    } else if (part.type === "reasoning-delta") {
      // Print reasoning text in a different color (e.g., yellow)
      process.stdout.write(`\x1b[33m${part.text}\x1b[0m`);
    } else if (part.type === "tool-result") {
      console.log({
        name: part.toolName,
        input: part.input,
        output: part.output,
      });
    } else if (part.type === "reasoning-end") {
      console.log("\n\n");
    }
  }

  console.log("\n\n<Complete>");
}

main().catch(console.error);
