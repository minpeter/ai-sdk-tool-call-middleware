import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { bfclParallelMultipleBenchmark, evaluate } from "@ai-sdk-tool/eval";
import { xmlToolMiddleware } from "@ai-sdk-tool/parser";
import { wrapLanguageModel } from "ai";

const openrouter = createOpenAICompatible({
  name: "openrouter",
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

async function main() {
  for (let i = 0; i < 8; i++) {
    const result = await evaluate({
      models: wrapLanguageModel({
        model: openrouter("xiaomi/mimo-v2-flash:free"),
        middleware: xmlToolMiddleware,
      }),
      benchmarks: [bfclParallelMultipleBenchmark],
      reporter: "none",
      temperature: 0.0,
      maxTokens: 256,
      cache: {
        cacheDir: ".benchmark-results/cache",
      },
    });

    console.log(result[0].result.metrics);
  }
}

main();
