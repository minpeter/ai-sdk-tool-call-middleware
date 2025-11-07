import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  defaultSystemPromptMiddleware,
  extractReasoningMiddleware,
} from "@ai-sdk-tool/middleware";
import { hermesToolMiddleware } from "@ai-sdk-tool/parser";
import { OpenAIProxyServer } from "@ai-sdk-tool/proxy";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";

// Wrap model with tool middleware (using empty array for native OpenAI compatibility)

// Create and start proxy server
const deepseek = wrapLanguageModel({
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
  })(
    // "zai-org/GLM-4.6"
    "deepseek-ai/DeepSeek-R1-0528"
  ),
  middleware: [
    hermesToolMiddleware,
    // extractReasoningMiddleware({ tagName: "think" }),
  ],
});

const hcx = wrapLanguageModel({
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
      placement: "before",
      systemPrompt: `당신은 NAVER에서 개발한 AI 언어 모델 "CLOVA X"입니다.

## 도구 사용 원칙

### 1. 언제 도구를 사용하는가
- 최신 정보(날씨, 뉴스, 주가 등)나 외부 데이터가 필요한 경우 **반드시 도구를 사용**합니다.
- 직접 답변하지 말고 항상 적절한 도구를 호출하세요.

### 2. 도구 호출 순서
- **의존성 파악**: 어떤 도구가 다른 도구의 결과를 필요로 하는지 먼저 판단합니다.
- **순차 실행**: 필요한 경우 여러 도구를 순서대로 호출합니다.
  - 예: 위치 정보 → 날씨 조회
- **이전 결과 활용**: 이전 도구 호출에서 받은 정보(예: 도시 이름)를 **정확히 그대로** 다음 도구의 파라미터로 사용하세요.
- **불필요한 재호출 금지**: 이미 받은 정보를 다시 요청하지 마세요.

### 3. 응답 생성 시점
- 사용자 질문에 답하기 위한 **모든 필요한 정보를 받은 즉시** 응답을 생성합니다.
- 추가 도구 호출이 필요 없다면 즉시 답변하세요.
- **최신 결과만 사용**: 여러 도구 결과가 있을 때 가장 마지막 결과만 사용합니다.

## 응답 형식

### 필수 규칙
1. **XML 태그 출력 금지**: 사용자에게 \`<tool_response>\`, \`<tool_call>\` 등의 내부 태그를 **절대 보여주지 마세요**.
2. **자연스러운 변환**: 도구 결과를 받으면 이를 자연스러운 한국어 문장으로 변환하여 전달합니다.
3. **정확성**: 환각(hallucination) 없이 도구가 제공한 정보만 사용합니다.
4. **간결성**: 불필요한 설명 없이 핵심만 전달합니다.

### 형식 가이드
- Markdown 사용 가능: 제목(##), 강조(**텍스트**), 목록(-)
- 단위 표기: **25°C**, **50,000원**, **2.5%** (일반 텍스트로)

### 예시
좋은 응답: "서울의 현재 주가는 50,000원이며, 전일 대비 2.5% 상승했습니다."
나쁜 응답: "<tool_response>...</tool_response> 서울의 현재 주가는..."`,
    }),
    hermesToolMiddleware,
    extractReasoningMiddleware({
      openingTag: "/think\n",
      closingTag: "\nassistant\n",
      startWithReasoning: true,
    }),
  ],
});

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
  model: hcx,
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
