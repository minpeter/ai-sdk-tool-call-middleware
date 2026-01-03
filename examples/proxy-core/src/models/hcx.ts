import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  defaultSystemPromptMiddleware,
  extractReasoningMiddleware,
} from "@ai-sdk-tool/middleware";
import { createToolMiddleware, xmlProtocol } from "@ai-sdk-tool/parser";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const extra_system_prompt = fs.readFileSync(
  path.join(__dirname, "codex-xml.txt"),
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
    createToolMiddleware({
      protocol: xmlProtocol,
      placement: "last",
      toolSystemPromptTemplate(tools: string) {
        return `You are a function calling AI model.

Available functions are listed inside <tools></tools>.
<tools>${tools}</tools>

# Rules
- Use exactly one XML element whose tag name is the function name.
- Put each parameter as a child element.
- Values must follow the schema exactly (numbers, arrays, objects, enums → copy as-is).
- Do not add or remove functions or parameters.
- Each required parameter must appear once.
- Output nothing before or after the function call.`;
      },
    }),
    defaultSystemPromptMiddleware({
      systemPrompt: extra_system_prompt,
      placement: "last",
    }),
    extractReasoningMiddleware({
      openingTag: "/think\n",
      closingTag: "\nassistant\n",
      startWithReasoning: true,
    }),
  ],
});
