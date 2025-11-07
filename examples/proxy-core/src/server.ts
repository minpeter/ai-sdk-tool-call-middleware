import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { OpenAIProxyServer } from "@ai-sdk-tool/proxy";
import { wrapLanguageModel } from "ai";

// Create base model
const friendli = createOpenAICompatible({
  name: "friendli",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
  includeUsage: true,
  fetch: (url, options) => {
    const body = options?.body ? JSON.parse(options.body as string) : {};
    body.parse_reasoning = true;
    return fetch(url, { ...options, body: JSON.stringify(body) });
  },
});

// Wrap model with tool middleware (using empty array for native OpenAI compatibility)
const wrappedModel = wrapLanguageModel({
  model: friendli("Qwen/Qwen3-235B-A22B-Thinking-2507"),
  middleware: [], // No middleware for native OpenAI compatibility
});

// Create and start proxy server
const server = new OpenAIProxyServer({
  model: wrappedModel,
  port: 3005,
  host: "localhost",
  cors: true,
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
