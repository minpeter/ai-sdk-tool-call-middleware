import { describe, expect, it } from "vitest";
import { buildOntologySnapshot } from "../src/stagepilot/ontology";

describe("stagepilot ontology", () => {
  it("includes citywide agencies and district agencies", () => {
    const snapshot = buildOntologySnapshot({
      caseId: "t-1",
      district: "Gangbuk-gu",
      notes: "Need support",
      risks: ["housing", "income"],
    });

    const names = snapshot.agencies.map((agency) => agency.name);

    expect(names).toContain("Dasan Call Center");
    expect(names).toContain("Health and Welfare Hotline");
    expect(names).toContain("Gangbuk Welfare Support");
  });

  it("matches programs by risk overlap", () => {
    const snapshot = buildOntologySnapshot({
      caseId: "t-2",
      district: "Jungnang-gu",
      notes: "Isolated and food insecure",
      risks: ["food", "isolation"],
    });

    const programNames = snapshot.programs.map((program) => program.name);
    expect(programNames.length).toBeGreaterThan(0);
    expect(programNames.some((name) => name.includes("Jungnang"))).toBe(true);
  });
});
