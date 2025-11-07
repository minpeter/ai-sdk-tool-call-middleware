import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { morphXmlToolMiddleware } from "@ai-sdk-tool/parser";
import { OpenAIProxyServer } from "@ai-sdk-tool/proxy";
import { extractReasoningMiddleware, wrapLanguageModel } from "ai";

// Wrap model with tool middleware (using empty array for native OpenAI compatibility)

// Create and start proxy server
const server = new OpenAIProxyServer({
  model: wrapLanguageModel({
    model: createOpenAICompatible({
      name: "friendli",
      apiKey: process.env.FRIENDLI_TOKEN,
      baseURL: "https://api.friendli.ai/serverless/v1",
      includeUsage: true,
    })(
      "zai-org/GLM-4.6"
      // "deepseek-ai/DeepSeek-R1-0528"
    ),

    middleware: [
      morphXmlToolMiddleware,
      extractReasoningMiddleware({ tagName: "think" }),
    ],
  }),
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
