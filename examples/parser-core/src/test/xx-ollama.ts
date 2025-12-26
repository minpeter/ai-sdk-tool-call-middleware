import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { morphXmlToolMiddleware } from "@ai-sdk-tool/parser";
import { generateText, stepCountIs, wrapLanguageModel } from "ai";
import { z } from "zod";

const MAX_STEPS = 3;
const MAX_TEMPERATURE = 100;

const ollama = createOpenAICompatible({
  name: "ollama",
  apiKey: "ollama",
  baseURL: "http://localhost:11434/v1",
});

async function main() {
  await generateText({
    model: wrapLanguageModel({
      model: ollama("phi-4"),
      middleware: morphXmlToolMiddleware,
    }),
    prompt: "What is the weather in New York and Los Angeles?",
    stopWhen: stepCountIs(MAX_STEPS),
    tools: {
      get_weather: {
        description:
          "Get the weather for a given city. " +
          "Example cities: 'New York', 'Los Angeles', 'Paris'.",
        inputSchema: z.object({ city: z.string() }),
        execute: ({ city }) => {
          // Simulate a weather API call
          return {
            city,
            temperature: Math.floor(Math.random() * MAX_TEMPERATURE),
            condition: "sunny",
          };
        },
      },
    },
    onStepFinish: (step) => {
      console.log({
        text: step.text,
        toolCalls: step.toolCalls.map(
          (call) =>
            `name: ${call.toolName}, input: ${JSON.stringify(call.input)}`
        ),
        toolResults: step.toolResults.map((result) =>
          JSON.stringify(result.output)
        ),
      });
    },
  });
}

main().catch(console.error);
