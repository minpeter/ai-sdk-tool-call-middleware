import type {
  AgencyNode,
  IntakeInput,
  OntologySnapshot,
  ProgramNode,
} from "./types";

const CITYWIDE_AGENCIES: AgencyNode[] = [
  {
    coverage: "citywide",
    id: "agency_120",
    name: "Dasan Call Center",
    phone: "120",
  },
  {
    coverage: "citywide",
    id: "agency_129",
    name: "Health and Welfare Hotline",
    phone: "129",
  },
];

const DISTRICT_AGENCIES: AgencyNode[] = [
  {
    coverage: "district",
    district: "gangbuk-gu",
    id: "agency_gangbuk_welfare",
    name: "Gangbuk Welfare Support",
    phone: "02-901-0000",
  },
  {
    coverage: "district",
    district: "jungnang-gu",
    id: "agency_jungnang_welfare",
    name: "Jungnang Welfare Support",
    phone: "02-2094-0000",
  },
];

const PROGRAMS: ProgramNode[] = [
  {
    agencyId: "agency_129",
    districtScope: "citywide",
    id: "program_emergency_support",
    name: "Emergency Livelihood Support",
    priority: 100,
    requiredRisks: ["income", "food", "housing"],
  },
  {
    agencyId: "agency_120",
    districtScope: "citywide",
    id: "program_call_navigation",
    name: "City Service Navigation",
    priority: 60,
    requiredRisks: ["other", "isolation", "care"],
  },
  {
    agencyId: "agency_gangbuk_welfare",
    districtScope: "district",
    id: "program_gangbuk_housing",
    name: "Gangbuk Housing Referral",
    priority: 90,
    requiredRisks: ["housing", "income"],
  },
  {
    agencyId: "agency_jungnang_welfare",
    districtScope: "district",
    id: "program_jungnang_daily_support",
    name: "Jungnang Daily Support",
    priority: 85,
    requiredRisks: ["food", "care", "isolation"],
  },
];

export function normalizeDistrict(district: string): string {
  return district.trim().toLowerCase().replace(/\s+/g, "-");
}

function isProgramApplicable(
  program: ProgramNode,
  intake: IntakeInput
): boolean {
  return intake.risks.some((risk) => program.requiredRisks.includes(risk));
}

function scoreProgram(program: ProgramNode, intake: IntakeInput): number {
  const overlap = intake.risks.filter((risk) =>
    program.requiredRisks.includes(risk)
  ).length;
  return program.priority + overlap * 10;
}

export function buildOntologySnapshot(input: IntakeInput): OntologySnapshot {
  const district = normalizeDistrict(input.district);

  const districtAgencies = DISTRICT_AGENCIES.filter((agency) => {
    return agency.district === district;
  });

  const agencies = [...CITYWIDE_AGENCIES, ...districtAgencies];
  const agencyIds = new Set(agencies.map((agency) => agency.id));

  const programs = PROGRAMS.filter((program) => {
    if (program.districtScope === "district") {
      const ownerAgency = DISTRICT_AGENCIES.find(
        (agency) => agency.id === program.agencyId
      );
      if (!ownerAgency || ownerAgency.district !== district) {
        return false;
      }
    }

    return (
      agencyIds.has(program.agencyId) && isProgramApplicable(program, input)
    );
  })
    .sort((a, b) => scoreProgram(b, input) - scoreProgram(a, input))
    .slice(0, 6);

  return {
    agencies,
    district,
    programs,
  };
}
