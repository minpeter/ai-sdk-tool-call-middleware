// Wrap model with tool middleware (using empty array for native OpenAI compatibility)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  defaultSystemPromptMiddleware,
  extractReasoningMiddleware,
} from "@ai-sdk-tool/middleware";
import {
  hermesToolMiddleware,
  morphXmlToolMiddleware,
} from "@ai-sdk-tool/parser";
import { OpenAIProxyServer } from "@ai-sdk-tool/proxy";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const glm_codex_xml_prompt = fs.readFileSync(
  path.join(__dirname, "glm-codex-xml.txt"),
  "utf8"
);

const hcx_tool_prompt = fs.readFileSync(
  path.join(__dirname, "hcx-tool-hermes.txt"),
  "utf8"
);

// Create and start proxy server
const _glm_codex = wrapLanguageModel({
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
      systemPrompt: glm_codex_xml_prompt,
      placement: "after",
    }),
  ],
});

const _hcx = wrapLanguageModel({
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

const _qwen = wrapLanguageModel({
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

const server = new OpenAIProxyServer({
  model: _glm_codex,
  port: 3005,
  host: "localhost",
  cors: true,
  logging: {
    requests: false,
    conversions: false,
    streamChunks: false,
  },
});

async function startServer() {
  try {
    await server.start();
    console.log("\n🎯 Proxy server is ready!");
    console.log("💡 You can now make OpenAI-compatible requests to:");
    console.log("   http://localhost:3000/v1/chat/completions");
    console.log("\n🧪 Test with:");
    console.log("   pnpm test");
    console.log("   or curl examples in README");
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down server...");
  try {
    await server.stop();
    process.exit(0);
  } catch (error) {
    console.error("Error during shutdown:", error);
    process.exit(1);
  }
});

startServer();
