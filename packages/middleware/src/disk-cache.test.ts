import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDiskCache,
  createDiskCacheMiddleware,
  getCacheStats,
} from "./disk-cache";

const TEST_CACHE_DIR = ".test-ai-cache";

function createMockModel(modelId: string) {
  return { modelId };
}

function createMockParams(prompt: string) {
  return { prompt };
}

async function collectStream(
  stream: ReadableStream<LanguageModelV3StreamPart>
) {
  const parts: LanguageModelV3StreamPart[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    parts.push(value);
  }
  return parts;
}

describe("createDiskCacheMiddleware", () => {
  beforeEach(async () => {
    await clearDiskCache(TEST_CACHE_DIR);
  });

  afterEach(async () => {
    await clearDiskCache(TEST_CACHE_DIR);
    vi.unstubAllEnvs();
  });

  describe("wrapGenerate", () => {
    it("should cache generate results on first call", async () => {
      const middleware = createDiskCacheMiddleware({
        cacheDir: TEST_CACHE_DIR,
      });
      const model = createMockModel("test-model");
      const params = createMockParams("Hello");
      let callCount = 0;

      const mockResult = {
        content: [{ type: "text" as const, text: "response" }],
        finishReason: "stop" as const,
        usage: { inputTokens: 10, outputTokens: 5 },
        warnings: [],
        response: {},
        providerMetadata: {},
        request: {},
      };

      const doGenerate = () => {
        callCount++;
        return Promise.resolve(mockResult);
      };

      const wrapGenerate = middleware.wrapGenerate;
      expect(wrapGenerate).toBeDefined();
      if (!wrapGenerate) {
        return;
      }

      const result1 = await wrapGenerate({
        doGenerate,
        params,
        model,
      } as any);

      expect(callCount).toBe(1);
      expect(result1.content).toEqual(mockResult.content);

      const result2 = await wrapGenerate({
        doGenerate,
        params,
        model,
      } as any);

      expect(callCount).toBe(1);
      expect(result2.content).toEqual(mockResult.content);
    });

    it("should call model for different params", async () => {
      const middleware = createDiskCacheMiddleware({
        cacheDir: TEST_CACHE_DIR,
      });
      const model = createMockModel("test-model");
      let callCount = 0;

      const doGenerate = () => {
        callCount++;
        return Promise.resolve({
          content: [],
          finishReason: "stop" as const,
          usage: { inputTokens: 0, outputTokens: 0 },
          warnings: [],
          response: {},
          providerMetadata: {},
          request: {},
        });
      };

      const wrapGenerate = middleware.wrapGenerate;
      expect(wrapGenerate).toBeDefined();
      if (!wrapGenerate) {
        return;
      }

      await wrapGenerate({
        doGenerate,
        params: createMockParams("Hello"),
        model,
      } as any);

      await wrapGenerate({
        doGenerate,
        params: createMockParams("Goodbye"),
        model,
      } as any);

      expect(callCount).toBe(2);
    });

    it("should respect enabled=false option", () => {
      const middleware = createDiskCacheMiddleware({
        cacheDir: TEST_CACHE_DIR,
        enabled: false,
      });

      expect(middleware.wrapGenerate).toBeUndefined();
      expect(middleware.wrapStream).toBeUndefined();
    });

    it("should respect AI_CACHE_ENABLED=false env var", () => {
      vi.stubEnv("AI_CACHE_ENABLED", "false");

      const middleware = createDiskCacheMiddleware({
        cacheDir: TEST_CACHE_DIR,
      });

      expect(middleware.wrapGenerate).toBeUndefined();
      expect(middleware.wrapStream).toBeUndefined();
    });

    it("should use custom generateKey function", async () => {
      const middleware = createDiskCacheMiddleware({
        cacheDir: TEST_CACHE_DIR,
        generateKey: (modelId, _params) => `custom-${modelId}`,
      });
      const model = createMockModel("my-model");
      let callCount = 0;

      const doGenerate = () => {
        callCount++;
        return Promise.resolve({
          content: [],
          finishReason: "stop" as const,
          usage: { inputTokens: 0, outputTokens: 0 },
          warnings: [],
          response: {},
          providerMetadata: {},
          request: {},
        });
      };

      const wrapGenerate = middleware.wrapGenerate;
      expect(wrapGenerate).toBeDefined();
      if (!wrapGenerate) {
        return;
      }

      await wrapGenerate({
        doGenerate,
        params: createMockParams("A"),
        model,
      } as any);

      await wrapGenerate({
        doGenerate,
        params: createMockParams("B"),
        model,
      } as any);

      expect(callCount).toBe(1);
    });

    it("should bypass cache read when forceRefresh=true", async () => {
      const middleware = createDiskCacheMiddleware({
        cacheDir: TEST_CACHE_DIR,
      });
      const forceRefreshMiddleware = createDiskCacheMiddleware({
        cacheDir: TEST_CACHE_DIR,
        forceRefresh: true,
      });
      const model = createMockModel("test-model");
      const params = createMockParams("ForceRefresh");
      let callCount = 0;

      const doGenerate = () => {
        callCount++;
        return Promise.resolve({
          content: [{ type: "text" as const, text: `response-${callCount}` }],
          finishReason: "stop" as const,
          usage: { inputTokens: 0, outputTokens: 0 },
          warnings: [],
          response: {},
          providerMetadata: {},
          request: {},
        });
      };

      const wrapGenerate = middleware.wrapGenerate;
      const wrapGenerateForce = forceRefreshMiddleware.wrapGenerate;
      expect(wrapGenerate).toBeDefined();
      expect(wrapGenerateForce).toBeDefined();
      if (!wrapGenerate) {
        return;
      }
      if (!wrapGenerateForce) {
        return;
      }

      await wrapGenerate({
        doGenerate,
        params,
        model,
      } as any);
      expect(callCount).toBe(1);

      await wrapGenerate({
        doGenerate,
        params,
        model,
      } as any);
      expect(callCount).toBe(1);

      await wrapGenerateForce({
        doGenerate,
        params,
        model,
      } as any);
      expect(callCount).toBe(2);
    });

    it("should respect AI_CACHE_FORCE_REFRESH=true env var", async () => {
      const middleware = createDiskCacheMiddleware({
        cacheDir: TEST_CACHE_DIR,
      });
      const model = createMockModel("test-model");
      const params = createMockParams("EnvForceRefresh");
      let callCount = 0;

      const doGenerate = () => {
        callCount++;
        return Promise.resolve({
          content: [],
          finishReason: "stop" as const,
          usage: { inputTokens: 0, outputTokens: 0 },
          warnings: [],
          response: {},
          providerMetadata: {},
          request: {},
        });
      };

      const wrapGenerate = middleware.wrapGenerate;
      expect(wrapGenerate).toBeDefined();
      if (!wrapGenerate) {
        return;
      }

      await wrapGenerate({
        doGenerate,
        params,
        model,
      } as any);
      expect(callCount).toBe(1);

      await wrapGenerate({
        doGenerate,
        params,
        model,
      } as any);
      expect(callCount).toBe(1);

      vi.stubEnv("AI_CACHE_FORCE_REFRESH", "true");
      const forceRefreshMiddleware = createDiskCacheMiddleware({
        cacheDir: TEST_CACHE_DIR,
      });
      const wrapGenerateForce = forceRefreshMiddleware.wrapGenerate;
      expect(wrapGenerateForce).toBeDefined();
      if (!wrapGenerateForce) {
        return;
      }

      await wrapGenerateForce({
        doGenerate,
        params,
        model,
      } as any);
      expect(callCount).toBe(2);
    });
  });

  describe("wrapStream", () => {
    it("should cache stream results on first call", async () => {
      const middleware = createDiskCacheMiddleware({
        cacheDir: TEST_CACHE_DIR,
      });
      const model = createMockModel("test-model");
      const params = createMockParams("Stream test");
      let callCount = 0;

      const mockParts = [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Hello" },
        { type: "text-delta", id: "t1", delta: " World" },
        { type: "text-end", id: "t1" },
        {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      ] as LanguageModelV3StreamPart[];

      const doStream = () => {
        callCount++;
        return Promise.resolve({
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              for (const part of mockParts) {
                controller.enqueue(part);
              }
              controller.close();
            },
          }),
          response: {},
          request: {},
        });
      };

      const wrapStream = middleware.wrapStream;
      expect(wrapStream).toBeDefined();
      if (!wrapStream) {
        return;
      }

      const result1 = await wrapStream({
        doStream,
        params,
        model,
      } as any);
      const parts1 = await collectStream(result1.stream);

      expect(callCount).toBe(1);
      expect(parts1).toHaveLength(5);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const result2 = await wrapStream({
        doStream,
        params,
        model,
      } as any);
      const parts2 = await collectStream(result2.stream);

      expect(callCount).toBe(1);
      expect(parts2).toEqual(parts1);
    });
  });
});

describe("clearDiskCache", () => {
  it("should remove cache directory", async () => {
    const cacheDir = ".test-clear-cache";
    mkdirSync(resolve(cacheDir), { recursive: true });
    writeFileSync(join(resolve(cacheDir), "test.json"), "{}");

    expect(existsSync(resolve(cacheDir))).toBe(true);

    await clearDiskCache(cacheDir);

    expect(existsSync(resolve(cacheDir))).toBe(false);
  });

  it("should not throw for non-existent directory", async () => {
    await expect(
      clearDiskCache(".non-existent-cache-dir")
    ).resolves.not.toThrow();
  });
});

describe("getCacheStats", () => {
  const STATS_CACHE_DIR = ".test-stats-cache";

  beforeEach(async () => {
    await clearDiskCache(STATS_CACHE_DIR);
  });

  afterEach(async () => {
    await clearDiskCache(STATS_CACHE_DIR);
  });

  it("should return zeros for empty cache", async () => {
    const stats = await getCacheStats(STATS_CACHE_DIR);
    expect(stats).toEqual({
      totalFiles: 0,
      totalSizeBytes: 0,
      generateCount: 0,
      streamCount: 0,
    });
  });

  it("should count cached files correctly", async () => {
    const cacheDir = resolve(STATS_CACHE_DIR);
    const subDir = join(cacheDir, "ab");
    mkdirSync(subDir, { recursive: true });

    writeFileSync(
      join(subDir, "abc123.json"),
      JSON.stringify({ type: "generate", content: [] })
    );
    writeFileSync(
      join(subDir, "def456.json"),
      JSON.stringify({ type: "stream", parts: [] })
    );

    const stats = await getCacheStats(STATS_CACHE_DIR);
    expect(stats.totalFiles).toBe(2);
    expect(stats.generateCount).toBe(1);
    expect(stats.streamCount).toBe(1);
    expect(stats.totalSizeBytes).toBeGreaterThan(0);
  });
});
