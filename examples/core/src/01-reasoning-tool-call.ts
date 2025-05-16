import { hermesToolMiddleware } from "@ai-sdk-tool/parser";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  extractReasoningMiddleware,
  generateText,
  maxSteps,
  wrapLanguageModel,
} from "ai";
import { z } from "zod";

const friendli = createOpenAICompatible({
  name: "friendli",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
});

async function main() {
  await generateText({
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
    prompt: "What is the weather in New York and Los Angeles?",
    continueUntil: maxSteps(4),
    tools: {
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
    onStepFinish: (step) => {
      console.log({
        text: step.text,
        reasoning: step.reasoning,
        toolCalls: step.toolCalls.map(
          (call) => `name: ${call.toolName}, args: ${JSON.stringify(call.args)}`
        ),
        toolResults: step.toolResults.map((result) =>
          JSON.stringify(result.result)
        ),
      });
    },
  });
}

main().catch(console.error);
