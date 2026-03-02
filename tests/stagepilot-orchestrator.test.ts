import { describe, expect, it } from "vitest";
import type { LlmGateway } from "../src/stagepilot/agents";
import { StagePilotEngine } from "../src/stagepilot/orchestrator";

class FakeGateway implements LlmGateway {
  summarizePlan(): Promise<string> {
    return Promise.resolve(
      "- Priority routing ready\n- Hotline and district flow prepared\n- SLA aligned"
    );
  }
}

class FailingGateway implements LlmGateway {
  summarizePlan(): Promise<string> {
    return Promise.reject(new Error("llm unavailable"));
  }
}

describe("stagepilot orchestrator", () => {
  it("builds a full execution plan with referrals", async () => {
    const engine = new StagePilotEngine({
      gateway: new FakeGateway(),
    });

    const result = await engine.run({
      caseId: "case-001",
      district: "Gangbuk-gu",
      notes: "Rent overdue and low food access",
      risks: ["housing", "food", "income"],
      urgencyHint: "high",
    });

    expect(result.eligibility.referrals.length).toBeGreaterThan(0);
    expect(result.plan.actions.length).toBeGreaterThanOrEqual(4);
    expect(result.safety.slaMinutes).toBe(120);
    expect(result.plan.summary).toContain("Priority routing ready");
    expect(result.judge.score).toBeGreaterThan(0);
  });

  it("falls back when llm summary fails", async () => {
    const engine = new StagePilotEngine({
      gateway: new FailingGateway(),
    });

    const result = await engine.run({
      caseId: "case-002",
      district: "Jungnang-gu",
      notes: "Need immediate routing",
      risks: ["food"],
      urgencyHint: "medium",
    });

    expect(result.plan.summary).toContain("SLA target");
  });
});
