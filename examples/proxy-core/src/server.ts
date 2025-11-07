import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { OpenAIProxyServer } from "@ai-sdk-tool/proxy";
import { wrapLanguageModel } from "ai";

// Wrap model with tool middleware (using empty array for native OpenAI compatibility)

// Create and start proxy server
// const deepseek = wrapLanguageModel({
//   model: createOpenAICompatible({
//     name: "friendli",
//     apiKey: process.env.FRIENDLI_TOKEN,
//     baseURL: "https://api.friendli.ai/serverless/v1",
//     includeUsage: true,
//     fetch: async (url, options) =>
//       await fetch(url, {
//         ...options,
//         body: JSON.stringify({
//           ...(options?.body ? JSON.parse(options.body as string) : {}),
//           chat_template_kwargs: {
//             enable_reasoning: true,
//           },
//           parse_reasoning: true,
//         }),
//       }),
//   })(
//     // "zai-org/GLM-4.6"
//     "deepseek-ai/DeepSeek-R1-0528"
//   ),
//   middleware: [
//     hermesToolMiddleware,
//     // extractReasoningMiddleware({ tagName: "think" }),
//   ],
// });

// const hcx = wrapLanguageModel({
//   model: createOpenAICompatible({
//     name: "friendli",
//     apiKey: process.env.FRIENDLI_TOKEN,
//     baseURL: "https://api.friendli.ai/serverless/v1",
//     fetch: async (url, options) =>
//       fetch(url, {
//         ...options,
//         body: JSON.stringify({
//           ...(options?.body ? JSON.parse(options.body as string) : {}),
//           parse_reasoning: false,
//           chat_template_kwargs: {
//             force_reasoning: true,
//           },
//         }),
//       }),
//   })("naver-hyperclovax/HyperCLOVAX-SEED-Think-14B"),
//   middleware: [
//     hermesToolMiddleware,
//     extractReasoningMiddleware({
//       openingTag: "/think\n",
//       closingTag: "\nassistant\n",
//       startWithReasoning: true,
//     }),
//   ],
// });

const qwen = wrapLanguageModel({
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
  middleware: [],
});

const server = new OpenAIProxyServer({
  model: qwen,
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
