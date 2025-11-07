import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { hermesToolMiddleware } from "@ai-sdk-tool/parser";
import { stepCountIs, streamText, wrapLanguageModel } from "ai";
import { z } from "zod";
import { extractReasoningMiddleware } from "./middleware/better-reasoning-middleware";

// Constants
const MAX_STEPS = 5;
const MAX_TEMPERATURE = 100;

const friendli = createOpenAICompatible({
  name: "friendli",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
  fetch: async (url, options) =>
    await fetch(url, {
      ...options,
      body: JSON.stringify({
        ...JSON.parse(options?.body as string),
        ...{
          parse_reasoning: false,
          chat_template_kwargs: {
            force_reasoning: true,
          },
        },
      }),
    }),
});

async function main() {
  const result = streamText({
    model: wrapLanguageModel({
      model: friendli("naver-hyperclovax/HyperCLOVAX-SEED-Think-14B"),
      middleware: [
        hermesToolMiddleware,
        extractReasoningMiddleware({
          openingTag: "/think\n",
          closingTag: "\nassistant\n",
          startWithReasoning: true,
        }),
      ],
    }),
    temperature: 0.1,
    system: `- 당신은 NAVER에서 개발한 AI 언어 모델 "CLOVA X"입니다.

### 핵심 지침
1.  **계획 우선:** 항상 문제 해결 계획을 먼저 수립한 후 도구를 사용합니다.
2.  **도구 필수 사용:** 최신 정보(뉴스, 주가 등)나 외부 정보가 필요할 때, 절대 직접 답하지 마세요. **반드시** \`<tool_call>\` XML 태그를 사용하여 필요한 함수를 호출해야 합니다.
3.  **즉시 응답 (중요):** 계획 수립 시, 만약 사용자의 질문에 답하는 데 필요한 정보가 **바로 직전의 \`<tool_response>\`를 통해 방금 제공되었다면**, 추가 도구를 호출하지 말고 **즉시 해당 정보를 사용하여 사용자에게 응답해야 합니다.**
4.  **최신 결과 사용:** 응답을 생성할 때, 대화 기록에 여러 도구 결과가 있더라도 **오직 가장 마지막의 최신 \`<tool_response>\` 내용만 사용**하고, 그 이전의 모든 오래된(stale) 결과는 **반드시 무시**해야 합니다.
5.  **응답 스타일:**
    * 환각(hallucination) 없이 정확하고 간결하게 응답합니다.
    * 명확한 구조를 위해 Markdown(##, *, **)을 사용합니다.
    * **LaTeX:** 복잡한 수학/과학($inline$, $$display$$)에만 사용합니다.
    * **LaTeX 금지:** 간단한 텍스트, 단위(예: **10%**, **180°C**), 비기술적 내용에는 절대 사용하지 않습니다.`,
    prompt: "지금 내가 있는 위치의 날씨는 어떤가요?",
    stopWhen: stepCountIs(MAX_STEPS),
    tools: {
      get_location: {
        description: "Get the User's location.",
        inputSchema: z.object({}),
        execute: () => {
          // Simulate a location API call
          return {
            city: "Busan",
            country: "South Korea",
          };
        },
      },
      get_weather: {
        description:
          "Get the weather for a given city. " +
          "Example cities: 'New York', 'Los Angeles', 'Paris'.",
        inputSchema: z.object({ city: z.string() }),
        execute: ({ city }) => {
          // Simulate a weather API call
          const temperature = Math.floor(Math.random() * MAX_TEMPERATURE);
          return {
            city,
            temperature,
            condition: "sunny",
          };
        },
      },
    },
  });

  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      process.stdout.write(part.text);
    } else if (part.type === "reasoning-delta") {
      // Print reasoning text in a different color (e.g., yellow)
      process.stdout.write(`\x1b[33m${part.text}\x1b[0m`);
    } else if (part.type === "tool-result") {
      console.log({
        name: part.toolName,
        input: part.input,
        output: part.output,
      });
    } else if (part.type === "reasoning-end") {
      console.log("\n\n");
    }
  }

  console.log("\n\n<Complete>");
}

main().catch(console.error);
