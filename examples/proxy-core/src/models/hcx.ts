import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  defaultSystemPromptMiddleware,
  extractReasoningMiddleware,
} from "@ai-sdk-tool/middleware";
import { hermesToolMiddleware } from "@ai-sdk-tool/parser";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const hcx_tool_prompt = fs.readFileSync(
  path.join(__dirname, "hcx-tool-hermes.txt"),
  "utf8"
);

export const hcx = wrapLanguageModel({
  model: createOpenAICompatible({
    name: "friendli",
    apiKey: process.env.FRIENDLI_TOKEN,
    baseURL: "https://api.friendli.ai/serverless/v1",
    fetch: async (url, options) =>
      fetch(url, {
        ...options,
        body: JSON.stringify({
          ...(options?.body ? JSON.parse(options.body as string) : {}),
          parse_reasoning: false,
          chat_template_kwargs: {
            force_reasoning: true,
          },
        }),
      }),
  })("naver-hyperclovax/HyperCLOVAX-SEED-Think-14B"),
  middleware: [
    defaultSettingsMiddleware({
      settings: {
        temperature: 0.1,
      },
    }),
    defaultSystemPromptMiddleware({
      systemPrompt: hcx_tool_prompt,
      placement: "after",
    }),
    hermesToolMiddleware,
    extractReasoningMiddleware({
      openingTag: "/think\n",
      closingTag: "\nassistant\n",
      startWithReasoning: true,
    }),
  ],
});
