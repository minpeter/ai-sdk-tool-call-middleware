import { createGuidedToolMiddleware } from "@ai-sdk-tool/parser";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, maxSteps, wrapLanguageModel } from "ai";
import { z } from "zod";

import OpenAI from "openai";

const openrouter = createOpenAICompatible({
  name: "openrouter",
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

const gemmaToolMiddleware = createGuidedToolMiddleware({
  toolSystemPromptTemplate(tools) {
    return `You are a function calling AI model.
You are provided with function signatures within <tools></tools> XML tags.
You may call one or more functions to assist with the user query.
Don't make assumptions about what values to plug into functions.
Here are the available tools: <tools>${tools}</tools>
Use the following pydantic model json schema for each tool call you will make: {'title': 'FunctionCall', 'type': 'object', 'properties': {'arguments': {'title': 'Arguments', 'type': 'object'}, 'name': {'title': 'Name', 'type': 'string'}}, 'required': ['arguments', 'name']}
For each function call return a json object with function name and arguments within <tool_call></tool_call> XML tags as follows:
<tool_call>
{'arguments': <args-dict>, 'name': <function-name>}
</tool_call>`;
  },
  toolCallTag: "<tool_call>",
  toolCallEndTag: "</tool_call>",
  toolResponseTag: "<tool_response>",
  toolResponseEndTag: "</tool_response>",
  guidedGeneration: {
    renderTemplateHfModel: "meta-llama/Llama-3.1-8B-Instruct",
    completionBaseUrl: "https://openrouter.ai/api/v1/completions",
    completionApiKey: process.env.OPENROUTER_API_KEY,
  },
});

async function main() {
  await generateText({
    model: wrapLanguageModel({
      model: openrouter("meta-llama/Llama-3.1-8B-Instruct"),
      middleware: gemmaToolMiddleware,
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
