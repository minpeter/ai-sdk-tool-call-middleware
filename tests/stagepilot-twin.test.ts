import { describe, expect, it } from "vitest";
import { StagePilotEngine } from "../src/stagepilot/orchestrator";
import { simulateStagePilotTwin } from "../src/stagepilot/twin";

describe("stagepilot digital-twin simulation", () => {
  it("improves SLA risk under positive what-if scenario", async () => {
    const engine = new StagePilotEngine();
    const result = await engine.run({
      caseId: "twin-001",
      district: "Jungnang-gu",
      notes: "food and isolation support needed",
      risks: ["food", "isolation"],
      urgencyHint: "high",
    });

    const optimistic = simulateStagePilotTwin({
      result,
      scenario: {
        contactRateDeltaPct: 10,
        demandDeltaPct: -20,
        staffingDeltaPct: 20,
      },
    });

    expect(optimistic.recommendation).not.toBeNull();
    expect(optimistic.simulated.expectedFirstContactMinutes).toBeLessThan(
      optimistic.baseline.expectedFirstContactMinutes
    );
    expect(optimistic.simulated.slaBreachProbability).toBeLessThanOrEqual(
      optimistic.baseline.slaBreachProbability
    );
    expect(optimistic.alternatives.length).toBeGreaterThan(0);
  });

  it("worsens SLA risk under overloaded scenario", async () => {
    const engine = new StagePilotEngine();
    const result = await engine.run({
      caseId: "twin-002",
      district: "Gangbuk-gu",
      notes: "housing and income crisis",
      risks: ["housing", "income", "food"],
      urgencyHint: "high",
    });

    const overloaded = simulateStagePilotTwin({
      result,
      scenario: {
        demandDeltaPct: 35,
        staffingDeltaPct: -30,
      },
    });

    expect(overloaded.simulated.expectedFirstContactMinutes).toBeGreaterThan(
      overloaded.baseline.expectedFirstContactMinutes
    );
    expect(overloaded.simulated.slaBreachProbability).toBeGreaterThanOrEqual(
      overloaded.baseline.slaBreachProbability
    );
  });

  it("applies profile calibration overrides", async () => {
    const engine = new StagePilotEngine();
    const result = await engine.run({
      caseId: "twin-003",
      district: "Gangbuk-gu",
      notes: "calibration check",
      risks: ["housing", "food"],
      urgencyHint: "medium",
    });

    const defaultTwin = simulateStagePilotTwin({ result });
    const calibratedTwin = simulateStagePilotTwin({
      profile: {
        avgHandleMinutes: 55,
        backlogCases: 120,
        caseWorkers: 6,
        contactSuccessRate: 0.65,
        demandPerHour: 11.5,
      },
      result,
    });

    expect(calibratedTwin.profile.avgHandleMinutes).toBe(55);
    expect(calibratedTwin.profile.backlogCases).toBe(120);
    expect(
      calibratedTwin.simulated.expectedFirstContactMinutes
    ).toBeGreaterThan(defaultTwin.simulated.expectedFirstContactMinutes);
  });
});
