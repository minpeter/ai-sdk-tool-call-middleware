import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";

declare const __PACKAGE_VERSION__: string;

export interface DiskCacheMiddlewareOptions {
  cacheDir?: string;
  enabled?: boolean;
  forceRefresh?: boolean;
  generateKey?: (modelId: string, params: unknown) => string;
  debug?: boolean;
}

interface CachedGenerateResult {
  type: "generate";
  content: unknown;
  finishReason: unknown;
  usage: unknown;
  warnings: unknown;
  response: unknown;
  providerMetadata: unknown;
  request: unknown;
}

interface CachedStreamResult {
  type: "stream";
  parts: LanguageModelV3StreamPart[];
  response: unknown;
  request: unknown;
}

type CachedResult = CachedGenerateResult | CachedStreamResult;

function defaultGenerateKey(modelId: string, params: unknown): string {
  const serialized = JSON.stringify(
    { version: __PACKAGE_VERSION__, modelId, params },
    (_key, value) => {
      if (typeof value === "function") {
        return "[function]";
      }
      if (value instanceof RegExp) {
        return value.toString();
      }
      return value;
    }
  );
  return createHash("sha256").update(serialized).digest("hex");
}

function getCachePath(cacheDir: string, key: string): string {
  return join(cacheDir, key.slice(0, 2), `${key}.json`);
}

async function readCache(cachePath: string): Promise<CachedResult | null> {
  try {
    const content = await readFile(cachePath, "utf-8");
    const parsed = JSON.parse(content) as CachedResult;
    if (parsed.response && typeof parsed.response === "object") {
      const resp = parsed.response as Record<string, unknown>;
      if (typeof resp.timestamp === "string") {
        resp.timestamp = new Date(resp.timestamp);
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(
  cachePath: string,
  result: CachedResult
): Promise<void> {
  try {
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(result), "utf-8");
  } catch {
    // Silent fail
  }
}

function createStreamFromParts(
  parts: LanguageModelV3StreamPart[]
): ReadableStream<LanguageModelV3StreamPart> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < parts.length) {
        controller.enqueue(parts[index++]);
      } else {
        controller.close();
      }
    },
  });
}

export function createDiskCacheMiddleware(
  options: DiskCacheMiddlewareOptions = {}
): LanguageModelV3Middleware {
  const generateKey = options.generateKey ?? defaultGenerateKey;
  const resolvedCacheDir = resolve(options.cacheDir ?? ".ai-cache");

  const envEnabled = process.env.AI_CACHE_ENABLED;
  const enabled =
    envEnabled !== undefined
      ? envEnabled.toLowerCase() === "true" || envEnabled === "1"
      : (options.enabled ?? true);

  const envDebug = process.env.AI_CACHE_DEBUG;
  const debug =
    envDebug !== undefined
      ? envDebug.toLowerCase() === "true" || envDebug === "1"
      : (options.debug ?? false);

  const envForceRefresh = process.env.AI_CACHE_FORCE_REFRESH;
  const forceRefresh =
    envForceRefresh !== undefined
      ? envForceRefresh.toLowerCase() === "true" || envForceRefresh === "1"
      : (options.forceRefresh ?? false);

  const log = debug
    ? (msg: string, data?: unknown) =>
        console.log(`[ai-cache] ${msg}`, data ?? "")
    : () => undefined;

  if (!enabled) {
    return { specificationVersion: "v3" };
  }

  return {
    specificationVersion: "v3",

    wrapGenerate: async ({ doGenerate, params, model }) => {
      const cacheKey = generateKey(model.modelId, params);
      const cachePath = getCachePath(resolvedCacheDir, cacheKey);

      if (!forceRefresh) {
        const cached = await readCache(cachePath);
        if (cached?.type === "generate") {
          log("HIT generate", cacheKey.slice(0, 8));
          return {
            content: cached.content,
            finishReason: cached.finishReason,
            usage: cached.usage,
            warnings: cached.warnings,
            response: cached.response,
            providerMetadata: cached.providerMetadata,
            request: cached.request,
          } as Awaited<ReturnType<typeof doGenerate>>;
        }
      }

      log(
        forceRefresh ? "REFRESH generate" : "MISS generate",
        cacheKey.slice(0, 8)
      );
      const result = await doGenerate();

      await writeCache(cachePath, {
        type: "generate",
        content: result.content,
        finishReason: result.finishReason,
        usage: result.usage,
        warnings: result.warnings,
        response: result.response,
        providerMetadata: result.providerMetadata,
        request: result.request,
      });

      return result;
    },

    wrapStream: async ({ doStream, params, model }) => {
      const cacheKey = generateKey(model.modelId, params);
      const cachePath = getCachePath(resolvedCacheDir, cacheKey);

      if (!forceRefresh) {
        const cached = await readCache(cachePath);
        if (cached?.type === "stream") {
          log("HIT stream", {
            key: cacheKey.slice(0, 8),
            parts: cached.parts.length,
          });
          return {
            stream: createStreamFromParts(cached.parts),
            response: cached.response,
            request: cached.request,
          } as Awaited<ReturnType<typeof doStream>>;
        }
      }

      log(
        forceRefresh ? "REFRESH stream" : "MISS stream",
        cacheKey.slice(0, 8)
      );
      const result = await doStream();

      const collectedParts: LanguageModelV3StreamPart[] = [];

      const cachedStream = result.stream.pipeThrough(
        new TransformStream<
          LanguageModelV3StreamPart,
          LanguageModelV3StreamPart
        >({
          transform(chunk, controller) {
            collectedParts.push(chunk);
            controller.enqueue(chunk);
          },
          flush() {
            writeCache(cachePath, {
              type: "stream",
              parts: collectedParts,
              response: result.response,
              request: result.request,
            });
          },
        })
      );

      return { ...result, stream: cachedStream };
    },
  };
}

export async function clearDiskCache(cacheDir = ".ai-cache"): Promise<void> {
  try {
    await rm(resolve(cacheDir), { recursive: true, force: true });
  } catch {
    // Directory doesn't exist
  }
}

export async function getCacheStats(cacheDir = ".ai-cache"): Promise<{
  totalFiles: number;
  totalSizeBytes: number;
  generateCount: number;
  streamCount: number;
}> {
  const resolvedDir = resolve(cacheDir);
  let totalFiles = 0;
  let totalSizeBytes = 0;
  let generateCount = 0;
  let streamCount = 0;

  async function walkDir(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      await Promise.all(
        entries.map(async (entry) => {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walkDir(fullPath);
          } else if (entry.name.endsWith(".json")) {
            totalFiles++;
            const fileStat = await stat(fullPath);
            totalSizeBytes += fileStat.size;

            try {
              const content = JSON.parse(
                await readFile(fullPath, "utf-8")
              ) as CachedResult;
              if (content.type === "generate") {
                generateCount++;
              } else if (content.type === "stream") {
                streamCount++;
              }
            } catch {
              // Skip malformed
            }
          }
        })
      );
    } catch {
      // Directory doesn't exist
    }
  }

  await walkDir(resolvedDir);
  return { totalFiles, totalSizeBytes, generateCount, streamCount };
}
