import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStagePilotOpenClawNotifierFromEnv,
  formatStagePilotOpenClawMessage,
} from "../src/stagepilot/openclaw";
import type { StagePilotResult } from "../src/stagepilot/types";

const ENV_KEYS = [
  "OPENCLAW_ENABLED",
  "OPENCLAW_CHANNEL",
  "OPENCLAW_TARGET",
  "OPENCLAW_THREAD_ID",
  "OPENCLAW_WEBHOOK_URL",
  "OPENCLAW_API_KEY",
  "OPENCLAW_WEBHOOK_TIMEOUT_MS",
  "OPENCLAW_CMD",
] as const;

const ENV_SNAPSHOT = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]])
) as Record<(typeof ENV_KEYS)[number], string | undefined>;
const FETCH_SNAPSHOT = globalThis.fetch;

const SAMPLE_RESULT: StagePilotResult = {
  eligibility: {
    referrals: [
      {
        agencyId: "agency_129",
        agencyName: "Health and Welfare Hotline",
        phone: "129",
        priority: 100,
        programId: "program_emergency_support",
        programName: "Emergency Livelihood Support",
        reason: "Matched risks: food",
      },
    ],
  },
  intake: {
    caseId: "case-001",
    contactWindow: "18:00-21:00",
    district: "gangbuk-gu",
    notes: "Need support",
    risks: ["food", "housing"],
    urgency: "high",
  },
  judge: {
    score: 98,
    strengths: ["strong routing"],
    weaknesses: [],
  },
  ontology: {
    agencies: [],
    district: "gangbuk-gu",
    programs: [],
  },
  outreach: {
    messages: [],
  },
  plan: {
    actions: [
      {
        channel: "phone",
        details: "Call 129",
        dueInHours: 1,
        owner: "case-worker",
        step: "Emergency hotline call",
      },
    ],
    fallbackRoute: "Call 120",
    summary: "summary",
  },
  safety: {
    flags: [],
    slaMinutes: 120,
  },
};

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = ENV_SNAPSHOT[key];
    if (typeof value === "undefined") {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  globalThis.fetch = FETCH_SNAPSHOT;
  vi.restoreAllMocks();
});

describe("stagepilot openclaw notifier", () => {
  it("formats notification message with core case details", () => {
    const text = formatStagePilotOpenClawMessage({
      result: SAMPLE_RESULT,
    });

    expect(text).toContain("[StagePilot] Case case-001");
    expect(text).toContain("District: gangbuk-gu");
    expect(text).toContain("Top routes:");
    expect(text).toContain("Immediate actions:");
  });

  it("returns disabled when OPENCLAW_ENABLED is off", async () => {
    process.env.OPENCLAW_ENABLED = "0";
    const notifier = createStagePilotOpenClawNotifierFromEnv();
    const outcome = await notifier({
      result: SAMPLE_RESULT,
    });

    expect(outcome.mode).toBe("disabled");
    expect(outcome.delivered).toBe(false);
  });

  it("returns dry-run mode when requested", async () => {
    process.env.OPENCLAW_ENABLED = "1";
    const notifier = createStagePilotOpenClawNotifierFromEnv();
    const outcome = await notifier({
      dryRun: true,
      result: SAMPLE_RESULT,
    });

    expect(outcome.mode).toBe("dry-run");
    expect(outcome.delivered).toBe(false);
  });

  it("returns not-configured when cli is missing", async () => {
    process.env.OPENCLAW_ENABLED = "1";
    process.env.OPENCLAW_CMD = "openclaw-command-not-found";
    process.env.OPENCLAW_TARGET = "@welfare-ops";

    const notifier = createStagePilotOpenClawNotifierFromEnv();
    const outcome = await notifier({
      result: SAMPLE_RESULT,
    });

    expect(outcome.mode).toBe("not-configured");
    expect(outcome.delivered).toBe(false);
  });

  it("returns webhook mode when webhook succeeds", async () => {
    process.env.OPENCLAW_ENABLED = "1";
    process.env.OPENCLAW_WEBHOOK_URL = "https://example.invalid/webhook";
    process.env.OPENCLAW_WEBHOOK_TIMEOUT_MS = "5000";

    globalThis.fetch = vi.fn(() => {
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const notifier = createStagePilotOpenClawNotifierFromEnv();
    const outcome = await notifier({
      result: SAMPLE_RESULT,
    });

    expect(outcome.mode).toBe("webhook");
    expect(outcome.delivered).toBe(true);
    expect(outcome.statusCode).toBe(200);
  });

  it("returns failed when webhook times out", async () => {
    process.env.OPENCLAW_ENABLED = "1";
    process.env.OPENCLAW_WEBHOOK_URL = "https://example.invalid/webhook";
    process.env.OPENCLAW_WEBHOOK_TIMEOUT_MS = "1000";

    globalThis.fetch = vi.fn((_input, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          return;
        }

        const onAbort = () => {
          const error = new Error("aborted");
          (error as Error & { name: string }).name = "AbortError";
          reject(error);
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }) as typeof fetch;

    const notifier = createStagePilotOpenClawNotifierFromEnv();
    const outcome = await notifier({
      result: SAMPLE_RESULT,
    });

    expect(outcome.mode).toBe("failed");
    expect(outcome.delivered).toBe(false);
    expect(outcome.detail).toContain("webhook timeout (1000ms)");
  }, 4000);

  it("returns failed when webhook error body stalls", async () => {
    process.env.OPENCLAW_ENABLED = "1";
    process.env.OPENCLAW_WEBHOOK_URL = "https://example.invalid/webhook";
    process.env.OPENCLAW_WEBHOOK_TIMEOUT_MS = "1000";

    const stalledBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial-error-body"));
      },
    });

    globalThis.fetch = vi.fn(() => {
      return Promise.resolve(new Response(stalledBody, { status: 500 }));
    }) as typeof fetch;

    const notifier = createStagePilotOpenClawNotifierFromEnv();
    const outcome = await notifier({
      result: SAMPLE_RESULT,
    });

    expect(outcome.mode).toBe("failed");
    expect(outcome.delivered).toBe(false);
    expect(outcome.detail).toContain("webhook responded 500");
  }, 4000);
});
