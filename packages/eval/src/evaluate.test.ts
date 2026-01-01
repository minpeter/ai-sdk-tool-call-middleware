import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Middleware,
} from "@ai-sdk/provider";
import { clearDiskCache } from "@ai-sdk-tool/middleware";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluate } from "./evaluate";
import type { BenchmarkResult, LanguageModelV3Benchmark } from "./interfaces";

const TEST_CACHE_DIR = ".test-eval-cache";

function createMockModel(
  modelId: string,
  callTracker?: string[]
): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    modelId,
    provider: "test-provider",
    supportedUrls: {},
    doGenerate: () => {
      if (callTracker) {
        callTracker.push(modelId);
      }
      return Promise.resolve({
        content: [{ type: "text" as const, text: "response" }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: {
            total: 10,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: 5,
            text: undefined,
            reasoning: undefined,
          },
        },
        warnings: [],
        response: { id: "test", modelId, timestamp: new Date() },
        providerMetadata: {},
        request: {},
      });
    },
    doStream: () => {
      throw new Error("Not implemented");
    },
  };
}

function createTransformingMiddleware(
  prefix: string
): LanguageModelV3Middleware {
  return {
    specificationVersion: "v3",
    transformParams: ({ params }) => {
      const existingPrompt = params.prompt || [];
      return Promise.resolve({
        ...params,
        prompt: [
          {
            role: "system" as const,
            content: `${prefix}: transformed`,
            providerOptions: undefined,
          },
          ...existingPrompt,
        ],
      });
    },
  };
}

function createSimpleBenchmark(): LanguageModelV3Benchmark {
  return {
    name: "test-benchmark",
    version: "1.0.0",
    description: "Test benchmark",
    async run(model): Promise<BenchmarkResult> {
      const modelObj = model as unknown as LanguageModelV3;
      const result = await modelObj.doGenerate({
        prompt: [
          {
            role: "user",
            content: [{ type: "text", text: "test" }],
            providerOptions: undefined,
          },
        ],
        tools: undefined,
        toolChoice: undefined,
        temperature: undefined,
        maxOutputTokens: undefined,
        topP: undefined,
        topK: undefined,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        seed: undefined,
        stopSequences: undefined,
        responseFormat: undefined,
        abortSignal: undefined,
        headers: undefined,
        providerOptions: undefined,
        includeRawChunks: false,
      } as LanguageModelV3CallOptions);
      return {
        score: 1,
        success: true,
        metrics: {
          text:
            result.content[0]?.type === "text" ? result.content[0].text : "",
        },
      };
    },
  };
}

describe("evaluate with cache and middleware", () => {
  beforeEach(async () => {
    await clearDiskCache(TEST_CACHE_DIR);
  });

  afterEach(async () => {
    await clearDiskCache(TEST_CACHE_DIR);
  });

  it("should generate different cache keys for different middlewares", async () => {
    const callTracker: string[] = [];
    const benchmark = createSimpleBenchmark();
    const baseModel = createMockModel("test-model", callTracker);

    const middlewareA = createTransformingMiddleware("middleware-A");
    const middlewareB = createTransformingMiddleware("middleware-B");

    await evaluate({
      models: {
        "model-with-middleware-A": {
          model: baseModel,
          middleware: middlewareA,
        },
      },
      benchmarks: [benchmark],
      reporter: "json",
      cache: {
        enabled: true,
        cacheDir: TEST_CACHE_DIR,
      },
    });

    await evaluate({
      models: {
        "model-with-middleware-B": {
          model: baseModel,
          middleware: middlewareB,
        },
      },
      benchmarks: [benchmark],
      reporter: "json",
      cache: {
        enabled: true,
        cacheDir: TEST_CACHE_DIR,
      },
    });

    expect(callTracker).toHaveLength(2);
  });

  it("should use cache when same middleware is applied", async () => {
    const callTracker: string[] = [];
    const benchmark = createSimpleBenchmark();
    const baseModel = createMockModel("test-model", callTracker);
    const middleware = createTransformingMiddleware("same-middleware");

    await evaluate({
      models: {
        "first-run": {
          model: baseModel,
          middleware,
        },
      },
      benchmarks: [benchmark],
      reporter: "json",
      cache: {
        enabled: true,
        cacheDir: TEST_CACHE_DIR,
      },
    });

    await evaluate({
      models: {
        "second-run": {
          model: baseModel,
          middleware,
        },
      },
      benchmarks: [benchmark],
      reporter: "json",
      cache: {
        enabled: true,
        cacheDir: TEST_CACHE_DIR,
      },
    });

    expect(callTracker).toHaveLength(1);
  });

  it("should support legacy LanguageModel without ModelConfig", async () => {
    const benchmark = createSimpleBenchmark();
    const model = createMockModel("legacy-model");

    const result = await evaluate({
      models: model,
      benchmarks: [benchmark],
      reporter: "json",
    });

    expect(result).toHaveLength(1);
    expect(result[0].model).toBe("legacy-model");
  });
});
