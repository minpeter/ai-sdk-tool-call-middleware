import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { hermesToolMiddleware } from "@ai-sdk-tool/parser";
import { wrapLanguageModel } from "ai";

export const qwen = wrapLanguageModel({
  model: createOpenAICompatible({
    name: "friendli",
    apiKey: process.env.FRIENDLI_TOKEN,
    baseURL: "https://api.friendli.ai/serverless/v1",
    fetch: async (url, options) =>
      fetch(url, {
        ...options,
        body: JSON.stringify({
          ...(options?.body ? JSON.parse(options.body as string) : {}),
          parse_reasoning: true,
        }),
      }),
  })("Qwen/Qwen3-235B-A22B-Thinking-2507"),
  middleware: [hermesToolMiddleware],
});
