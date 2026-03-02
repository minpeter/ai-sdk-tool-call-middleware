import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GEMINI_HTTP_TIMEOUT_MS,
  GeminiGateway,
  normalizeGeminiHttpTimeoutMs,
  readGeminiHttpTimeoutMs,
} from "../src/stagepilot/agents";

function createAbortError(): Error {
  const error = new Error("aborted");
  (error as Error & { name: string }).name = "AbortError";
  return error;
}

function createStalledJsonResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          '{"candidates":[{"content":{"parts":[{"text":"'
        )
      );
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
    },
    status: 200,
  });
}

describe("stagepilot gemini gateway timeout guards", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("normalizes timeout values with clamping", () => {
    expect(normalizeGeminiHttpTimeoutMs(undefined)).toBe(
      DEFAULT_GEMINI_HTTP_TIMEOUT_MS
    );
    expect(normalizeGeminiHttpTimeoutMs(Number.NaN)).toBe(
      DEFAULT_GEMINI_HTTP_TIMEOUT_MS
    );
    expect(normalizeGeminiHttpTimeoutMs(100)).toBe(1000);
    expect(normalizeGeminiHttpTimeoutMs(1200.9)).toBe(1200);
    expect(normalizeGeminiHttpTimeoutMs(40_000)).toBe(30_000);
  });

  it("reads timeout from env-like raw strings", () => {
    expect(readGeminiHttpTimeoutMs(undefined)).toBe(
      DEFAULT_GEMINI_HTTP_TIMEOUT_MS
    );
    expect(readGeminiHttpTimeoutMs("")).toBe(DEFAULT_GEMINI_HTTP_TIMEOUT_MS);
    expect(readGeminiHttpTimeoutMs("2500")).toBe(2500);
    expect(readGeminiHttpTimeoutMs("999999")).toBe(30_000);
  });

  it("aborts hanging gemini requests and throws timeout error", async () => {
    globalThis.fetch = vi.fn((_input, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          return;
        }

        const onAbort = () => reject(createAbortError());
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }) as typeof fetch;

    const gateway = new GeminiGateway("test-key", "gemini-test", 1000);
    await expect(
      gateway.summarizePlan({
        intake: {
          caseId: "timeout-case",
          contactWindow: "18:00-21:00",
          district: "Gangbuk-gu",
          notes: "Need timeout safety",
          risks: ["food"],
          urgency: "high",
        },
        plan: {
          actions: [],
          fallbackRoute: "fallback",
          summary: "summary",
        },
        safety: {
          flags: [],
          slaMinutes: 120,
        },
      })
    ).rejects.toThrow("Gemini request timed out (1000ms)");
  }, 4000);

  it("times out when gemini response body stalls", async () => {
    globalThis.fetch = vi.fn(() => {
      return Promise.resolve(createStalledJsonResponse());
    }) as typeof fetch;

    const gateway = new GeminiGateway("test-key", "gemini-test", 1000);
    await expect(
      gateway.summarizePlan({
        intake: {
          caseId: "timeout-case-2",
          contactWindow: "18:00-21:00",
          district: "Gangbuk-gu",
          notes: "Need response-body timeout safety",
          risks: ["food"],
          urgency: "high",
        },
        plan: {
          actions: [],
          fallbackRoute: "fallback",
          summary: "summary",
        },
        safety: {
          flags: [],
          slaMinutes: 120,
        },
      })
    ).rejects.toThrow("Gemini response body timed out (1000ms)");
  }, 4000);
});
