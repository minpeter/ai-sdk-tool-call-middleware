import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defaultSystemPromptMiddleware } from "@ai-sdk-tool/middleware";
import { morphXmlToolMiddleware } from "@ai-sdk-tool/parser";
import { wrapLanguageModel } from "ai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const extra_system_prompt = fs.readFileSync(
  path.join(__dirname, "codex-xml.txt"),
  "utf8"
);

export const glm_codex = wrapLanguageModel({
  model: createOpenAICompatible({
    name: "friendli",
    apiKey: process.env.FRIENDLI_TOKEN,
    baseURL: "https://api.friendli.ai/serverless/v1",
    includeUsage: true,
    fetch: async (url, options) =>
      await fetch(url, {
        ...options,
        body: JSON.stringify({
          ...(options?.body ? JSON.parse(options.body as string) : {}),
          chat_template_kwargs: {
            enable_reasoning: true,
          },
          parse_reasoning: true,
        }),
      }),
  })("zai-org/GLM-4.6"),
  middleware: [
    morphXmlToolMiddleware,
    defaultSystemPromptMiddleware({
      systemPrompt: extra_system_prompt,
      placement: "last",
    }),
  ],
});
