import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { hermesToolMiddleware } from "@ai-sdk-tool/parser";
import {
  extractReasoningMiddleware,
  generateText,
  stepCountIs,
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
      model: friendli("deepseek-ai/DeepSeek-R1-0528"),

      middleware: [
        // The order is important, extractReasoningMiddleware is called first and then hermesToolMiddleware,
        // because inside <think> the <tool_call> tag is created for reasoning and the tool call mode is triggered.
        hermesToolMiddleware,
        extractReasoningMiddleware({ tagName: "think" }),
      ],
    }),
    system: "You are a helpful assistant.",
    prompt: "What is the weather in New York and Los Angeles?",
    stopWhen: stepCountIs(4),
    tools: {
      get_weather: {
        description:
          "Get the weather for a given city. " +
          "Example cities: 'New York', 'Los Angeles', 'Paris'.",
        inputSchema: z.object({ city: z.string() }),
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
    onStepFinish: step => {
      console.log({
        text: step.text,
        reasoning: step.reasoning,
        toolCalls: step.toolCalls.map(
          call => `name: ${call.toolName}, input: ${JSON.stringify(call.input)}`
        ),
        toolResults: step.toolResults.map(result =>
          JSON.stringify(result.output)
        ),
      });
    },
  });
}

main().catch(console.error);
