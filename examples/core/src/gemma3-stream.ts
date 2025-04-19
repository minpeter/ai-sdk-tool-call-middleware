import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText, wrapLanguageModel } from "ai";
import { z } from "zod";
import { createToolMiddleware } from "@ai-sdk-tool/parser";

const openrouter = createOpenAICompatible({
  name: "openrouter",
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

async function main() {
  const result = streamText({
    // model: openrouter("openai/gpt-4o"),
    model: wrapLanguageModel({
      model: openrouter("google/gemma-3-27b-it"),
      // model: openrouter("nousresearch/hermes-3-llama-3.1-70b"),
      middleware: createToolMiddleware({
        toolSystemPromptTemplate(tools) {
          return `You have access to functions. If you decide to invoke any of the function(s),
        you MUST put it in the format of
        \`\`\`tool_call
        {'name': <function-name>, 'arguments': <args-dict>}
        \`\`\`
        You SHOULD NOT include any other text in the response if you call a function
        ${tools}`;
        },
        toolCallTag: "```tool_call\n",
        toolCallEndTag: "```",
        toolResponseTag: "```tool_response\n",
        toolResponseEndTag: "\n```",
      }),
    }),
    system: "You are a helpful assistant.",
    // prompt: "What is the weather in New York and Los Angeles?",
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
    if (part.type === "text-delta") {
      process.stdout.write(part.textDelta);
    } else if (part.type === "tool-result") {
      console.log({
        name: part.toolName,
        args: part.args,
        result: part.result,
      });
    }
  }

  console.log("\n\n[done]");
}

main().catch(console.error);
