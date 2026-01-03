import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  bfclMultiTurnBaseBenchmark,
  evaluate,
  type ReporterType,
} from "@ai-sdk-tool/eval";

const friendli = createOpenAICompatible({
  name: "friendli",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
  includeUsage: true,
  fetch: async (url, options) =>
    await fetch(url, {
      ...options,
      body: JSON.stringify({
        ...(options?.body ? JSON.parse(options.body as string) : {}),
        parse_reasoning: true,
        chat_template_kwargs: {
          enable_thinking: false,
        },
      }),
    }),
});

// NOTE: K-EXAONE native tool calling support is uncertain.
// If tests fail with "force-terminated", the model may not support tool calling properly.
// In that case, consider:
// 1. Using a different model (e.g., Llama 3 70B which has proven tool calling support)
// 2. Using morphXML prompt-based tool calling simulation
// 3. Running with BFCL_DEBUG=true to inspect actual model responses
const model = friendli("zai-org/GLM-4.6");

async function main() {
  const reporterEnv = process.env.EVAL_REPORTER as ReporterType | undefined;

  await evaluate({
    models: {
      native: model,
    },
    benchmarks: [bfclMultiTurnBaseBenchmark],
    reporter: reporterEnv ?? "console",
    maxTokens: 8192,
  });
}

main();
