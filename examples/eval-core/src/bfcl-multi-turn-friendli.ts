import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  bfclMultiTurnBaseBenchmark,
  evaluate,
  type ReporterType,
} from "@ai-sdk-tool/eval";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const CACHE_DIR = path.join(REPO_ROOT, ".benchmark-results/cache");

const friendli = createOpenAICompatible({
  name: "friendli",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
  includeUsage: true,
  fetch: (url, options) =>
    fetch(url, {
      ...options,
      body: JSON.stringify({
        ...(options?.body ? JSON.parse(options.body as string) : {}),
        parse_reasoning: true,
        chat_template_kwargs: {
          enable_thinking: true,
        },
      }),
    }),
});

// GLM-4.6 has good function calling support
const model = friendli("LGAI-EXAONE/K-EXAONE-236B-A23B");

async function main() {
  const reporterEnv = process.env.EVAL_REPORTER as ReporterType | undefined;

  await evaluate({
    models: {
      native: model,
    },
    benchmarks: [bfclMultiTurnBaseBenchmark],
    reporter: reporterEnv ?? "console",
    maxTokens: 8192,
    cache: {
      enabled: true,
      cacheDir: CACHE_DIR,
      debug: process.env.CACHE_DEBUG === "true",
    },
  });
}

main();
