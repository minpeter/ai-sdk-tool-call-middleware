import { OpenAIProxyServer } from "@ai-sdk-tool/proxy";

import { glm_codex } from "./models/glm-codex";

const server = new OpenAIProxyServer({
  model: glm_codex,
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
