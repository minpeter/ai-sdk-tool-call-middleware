import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { xmlToolMiddleware } from "@ai-sdk-tool/parser";
import { stepCountIs, streamText, wrapLanguageModel } from "ai";
import { z } from "zod";

const MAX_STEPS = 3;
const MAX_TEMPERATURE = 100;

const ollama = createOpenAICompatible({
  name: "ollama",
  apiKey: "ollama",
  baseURL: "http://localhost:11434/v1",
});

async function main() {
  const result = streamText({
    model: wrapLanguageModel({
      model: ollama("phi-4"),
      middleware: xmlToolMiddleware,
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
  });

  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
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
