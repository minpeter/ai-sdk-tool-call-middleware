import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveStagePilotInsights } from "../src/stagepilot/insights";
import type { StagePilotResult } from "../src/stagepilot/types";

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
    caseId: "insights-case-001",
    contactWindow: "18:00-21:00",
    district: "gangbuk-gu",
    notes: "Need support",
    risks: ["food", "housing"],
    urgency: "high",
  },
  judge: {
    score: 92,
    strengths: ["routing"],
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

describe("stagepilot insights timeout fallback", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("falls back when gemini response body stalls", async () => {
    globalThis.fetch = vi.fn(() => {
      return Promise.resolve(createStalledJsonResponse());
    }) as typeof fetch;

    const insights = await deriveStagePilotInsights({
      apiKey: "test-key",
      model: "gemini-test",
      result: SAMPLE_RESULT,
      timeoutMs: 1000,
    });

    expect(insights.source).toBe("fallback");
    expect(insights.narrative).toContain("SLA target is");
  }, 4000);
});
