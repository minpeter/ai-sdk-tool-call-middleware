// 가장 단순한 V5 미들웨어 테스트
// AI SDK v5의 wrapLanguageModel이 미들웨어를 어떻게 기대하는지 확인

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, wrapLanguageModel } from "ai";

// 아무것도 안 하는 빈 미들웨어
const noopMiddleware = {
  // V5에서는 middlewareVersion 없어도 됨
};

// 약간의 로깅만 하는 미들웨어
const loggingMiddleware = {
  async transformParams({ params }) {
    console.log("[middleware] transformParams called");
    return params;
  },
  wrapGenerate({ doGenerate }) {
    console.log("[middleware] wrapGenerate called");
    return doGenerate();
  },
};

async function test() {
  const baseProvider = createOpenAICompatible({
    name: "friendli",
    baseURL: "https://api.friendli.ai/serverless/v1",
    apiKey: process.env.FRIENDLI_TOKEN,
  });

  const baseModel = baseProvider.languageModel("zai-org/GLM-4.6");

  console.log("1. Testing with noop middleware...");
  const wrappedNoop = wrapLanguageModel({
    model: baseModel,
    middleware: noopMiddleware,
  });
  console.log("   Wrapped model created:", typeof wrappedNoop);

  console.log("\n2. Testing with logging middleware...");
  const wrappedLogging = wrapLanguageModel({
    model: baseModel,
    middleware: loggingMiddleware,
  });
  console.log("   Wrapped model created:", typeof wrappedLogging);

  console.log("\n3. Testing actual generation with logging middleware...");
  try {
    const result = await generateText({
      model: wrappedLogging,
      prompt: "Say hi in one word",
      maxTokens: 10,
    });
    console.log("   Result:", result.text);
  } catch (e) {
    console.error("   Error:", e.message);
  }
}

test();
