import type { ProgramNode, StagePilotResult, UrgencyLevel } from "./types";

export interface StagePilotTwinProfile {
  avgHandleMinutes: number;
  backlogCases: number;
  caseWorkers: number;
  contactSuccessRate: number;
  demandPerHour: number;
}

export interface StagePilotTwinProfileInput {
  avgHandleMinutes?: number;
  backlogCases?: number;
  caseWorkers?: number;
  contactSuccessRate?: number;
  demandPerHour?: number;
}

const DISTRICT_PROFILES: Record<string, StagePilotTwinProfile> = {
  "gangbuk-gu": {
    avgHandleMinutes: 34,
    backlogCases: 42,
    caseWorkers: 10,
    contactSuccessRate: 0.74,
    demandPerHour: 8.4,
  },
  "jungnang-gu": {
    avgHandleMinutes: 36,
    backlogCases: 47,
    caseWorkers: 11,
    contactSuccessRate: 0.72,
    demandPerHour: 8.8,
  },
};

const DEFAULT_PROFILE: StagePilotTwinProfile = {
  avgHandleMinutes: 38,
  backlogCases: 30,
  caseWorkers: 9,
  contactSuccessRate: 0.76,
  demandPerHour: 6.9,
};

const MAX_ABS_DELTA_PCT = 80;

export interface StagePilotTwinScenarioInput {
  contactRateDeltaPct?: number;
  demandDeltaPct?: number;
  staffingDeltaPct?: number;
}

export interface StagePilotTwinScenario {
  contactRateDeltaPct: number;
  contactRateMultiplier: number;
  demandDeltaPct: number;
  demandMultiplier: number;
  staffingDeltaPct: number;
  staffingMultiplier: number;
}

export interface StagePilotTwinMetrics {
  capacityUtilization: number;
  contactSuccessRate: number;
  coverageScore: number;
  expectedFirstContactMinutes: number;
  predictedQueueMinutes: number;
  slaBreachProbability: number;
  throughputCasesPerHour: number;
}

export interface StagePilotTwinRouteOption {
  agencyName: string;
  expectedWaitMinutes: number;
  phone: string;
  score: number;
  slaBreachProbability: number;
}

export interface StagePilotTwinResult {
  alternatives: StagePilotTwinRouteOption[];
  baseline: StagePilotTwinMetrics;
  delta: {
    coverageScore: number;
    expectedFirstContactMinutes: number;
    slaBreachProbability: number;
  };
  district: string;
  profile: StagePilotTwinProfile;
  recommendation: StagePilotTwinRouteOption | null;
  scenario: StagePilotTwinScenario;
  simulated: StagePilotTwinMetrics;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100;
}

function toMultiplier(deltaPct: number): number {
  return 1 + deltaPct / 100;
}

function sanitizeNumber(
  value: unknown,
  options: {
    fallback: number;
    max: number;
    min: number;
  }
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return options.fallback;
  }

  return clamp(value, options.min, options.max);
}

function normalizeDelta(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return clamp(Math.trunc(value), -MAX_ABS_DELTA_PCT, MAX_ABS_DELTA_PCT);
}

function normalizeScenario(
  input: StagePilotTwinScenarioInput | undefined
): StagePilotTwinScenario {
  const staffingDeltaPct = normalizeDelta(input?.staffingDeltaPct);
  const demandDeltaPct = normalizeDelta(input?.demandDeltaPct);
  const contactRateDeltaPct = normalizeDelta(input?.contactRateDeltaPct);

  return {
    contactRateDeltaPct,
    contactRateMultiplier: toMultiplier(contactRateDeltaPct),
    demandDeltaPct,
    demandMultiplier: toMultiplier(demandDeltaPct),
    staffingDeltaPct,
    staffingMultiplier: toMultiplier(staffingDeltaPct),
  };
}

function getUrgencyDemandMultiplier(urgency: UrgencyLevel): number {
  if (urgency === "high") {
    return 1.35;
  }
  if (urgency === "low") {
    return 0.8;
  }
  return 1;
}

function resolveProfile(
  district: string,
  override: StagePilotTwinProfileInput | undefined
): StagePilotTwinProfile {
  const base = DISTRICT_PROFILES[district] ?? DEFAULT_PROFILE;

  return {
    avgHandleMinutes: sanitizeNumber(override?.avgHandleMinutes, {
      fallback: base.avgHandleMinutes,
      max: 120,
      min: 10,
    }),
    backlogCases: sanitizeNumber(override?.backlogCases, {
      fallback: base.backlogCases,
      max: 500,
      min: 0,
    }),
    caseWorkers: sanitizeNumber(override?.caseWorkers, {
      fallback: base.caseWorkers,
      max: 200,
      min: 1,
    }),
    contactSuccessRate: sanitizeNumber(override?.contactSuccessRate, {
      fallback: base.contactSuccessRate,
      max: 0.99,
      min: 0.2,
    }),
    demandPerHour: sanitizeNumber(override?.demandPerHour, {
      fallback: base.demandPerHour,
      max: 100,
      min: 0.1,
    }),
  };
}

function computeMetrics(options: {
  profile: StagePilotTwinProfile;
  result: StagePilotResult;
  scenario: StagePilotTwinScenario;
}): StagePilotTwinMetrics {
  const { profile, result, scenario } = options;
  const referralsCount = result.eligibility.referrals.length;
  const urgencyMultiplier = getUrgencyDemandMultiplier(result.intake.urgency);

  const workers = Math.max(
    1,
    profile.caseWorkers * scenario.staffingMultiplier
  );
  const throughputCasesPerHour = workers * (60 / profile.avgHandleMinutes);

  const demandPerHour =
    profile.demandPerHour * scenario.demandMultiplier * urgencyMultiplier;
  const capacityUtilization =
    demandPerHour / Math.max(throughputCasesPerHour, 0.1);

  const predictedQueueMinutes =
    (profile.backlogCases / Math.max(throughputCasesPerHour, 0.1)) * 60;

  const referralBoost = clamp(referralsCount * 0.03, 0, 0.14);
  const contactSuccessRate = clamp(
    profile.contactSuccessRate * scenario.contactRateMultiplier + referralBoost,
    0.25,
    0.98
  );

  const contactPenaltyMinutes = (1 - contactSuccessRate) * 120;
  const overloadPenaltyMinutes = Math.max(0, capacityUtilization - 1) * 45;
  const expectedFirstContactMinutes =
    predictedQueueMinutes + contactPenaltyMinutes + overloadPenaltyMinutes;

  const slaRatio =
    expectedFirstContactMinutes / Math.max(result.safety.slaMinutes, 1);
  const slaBreachProbability = clamp(
    0.04 +
      Math.max(0, slaRatio - 0.75) * 0.8 +
      Math.max(0, capacityUtilization - 1) * 0.4,
    0.02,
    0.99
  );

  const coverageScore = clamp(
    referralsCount * 18 +
      result.judge.score * 0.45 +
      (1 - slaBreachProbability) * 20,
    0,
    100
  );

  return {
    capacityUtilization: toTwoDecimals(capacityUtilization),
    contactSuccessRate: toTwoDecimals(contactSuccessRate),
    coverageScore: toTwoDecimals(coverageScore),
    expectedFirstContactMinutes: toTwoDecimals(expectedFirstContactMinutes),
    predictedQueueMinutes: toTwoDecimals(predictedQueueMinutes),
    slaBreachProbability: toTwoDecimals(slaBreachProbability),
    throughputCasesPerHour: toTwoDecimals(throughputCasesPerHour),
  };
}

function isDistrictProgram(program: ProgramNode | undefined): boolean {
  return program?.districtScope === "district";
}

function buildRouteOptions(
  result: StagePilotResult,
  metrics: StagePilotTwinMetrics
): StagePilotTwinRouteOption[] {
  const programById = new Map(
    result.ontology.programs.map((program) => [program.id, program])
  );

  const options: StagePilotTwinRouteOption[] = result.eligibility.referrals.map(
    (referral) => {
      const program = programById.get(referral.programId);
      const districtBoost = isDistrictProgram(program) ? 0.16 : 0.06;
      const priorityBoost = clamp(referral.priority / 300, 0.1, 0.45);

      const expectedWaitMinutes = Math.max(
        10,
        metrics.expectedFirstContactMinutes *
          (1.1 - districtBoost - priorityBoost)
      );

      const slaBreachProbability = clamp(
        expectedWaitMinutes / Math.max(result.safety.slaMinutes, 1) - 0.55,
        0.01,
        0.99
      );

      const score = clamp(
        100 -
          slaBreachProbability * 65 +
          referral.priority * 0.2 +
          result.judge.score * 0.12,
        0,
        100
      );

      return {
        agencyName: referral.agencyName,
        expectedWaitMinutes: toTwoDecimals(expectedWaitMinutes),
        phone: referral.phone,
        score: toTwoDecimals(score),
        slaBreachProbability: toTwoDecimals(slaBreachProbability),
      };
    }
  );

  if (options.length > 0) {
    return options.sort((a, b) => b.score - a.score);
  }

  const fallbackAgencies = result.ontology.agencies.slice(0, 2);
  return fallbackAgencies.map((agency, index) => {
    const expectedWaitMinutes =
      metrics.expectedFirstContactMinutes + index * 12;
    const slaBreachProbability = clamp(
      expectedWaitMinutes / Math.max(result.safety.slaMinutes, 1) - 0.55,
      0.05,
      0.99
    );

    return {
      agencyName: agency.name,
      expectedWaitMinutes: toTwoDecimals(expectedWaitMinutes),
      phone: agency.phone,
      score: toTwoDecimals(
        clamp(75 - index * 8 - slaBreachProbability * 50, 0, 100)
      ),
      slaBreachProbability: toTwoDecimals(slaBreachProbability),
    };
  });
}

export function simulateStagePilotTwin(options: {
  profile?: StagePilotTwinProfileInput;
  result: StagePilotResult;
  scenario?: StagePilotTwinScenarioInput;
}): StagePilotTwinResult {
  const { result } = options;
  const scenario = normalizeScenario(options.scenario);
  const baselineScenario = normalizeScenario(undefined);
  const profile = resolveProfile(result.intake.district, options.profile);

  const baseline = computeMetrics({
    profile,
    result,
    scenario: baselineScenario,
  });

  const simulated = computeMetrics({
    profile,
    result,
    scenario,
  });

  const alternatives = buildRouteOptions(result, simulated);
  const recommendation = alternatives[0] ?? null;

  return {
    alternatives,
    baseline,
    delta: {
      coverageScore: toTwoDecimals(
        simulated.coverageScore - baseline.coverageScore
      ),
      expectedFirstContactMinutes: toTwoDecimals(
        simulated.expectedFirstContactMinutes -
          baseline.expectedFirstContactMinutes
      ),
      slaBreachProbability: toTwoDecimals(
        simulated.slaBreachProbability - baseline.slaBreachProbability
      ),
    },
    district: result.intake.district,
    profile,
    recommendation,
    scenario,
    simulated,
  };
}
