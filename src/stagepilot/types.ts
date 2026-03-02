export type RiskType =
  | "housing"
  | "food"
  | "income"
  | "isolation"
  | "care"
  | "other";

export type UrgencyLevel = "high" | "medium" | "low";

export interface IntakeInput {
  caseId: string;
  contactWindow?: string;
  district: string;
  notes: string;
  risks: RiskType[];
  urgencyHint?: UrgencyLevel;
}

export interface NormalizedIntake {
  caseId: string;
  contactWindow: string;
  district: string;
  notes: string;
  risks: RiskType[];
  urgency: UrgencyLevel;
}

export interface AgencyNode {
  coverage: "citywide" | "district";
  district?: string;
  id: string;
  name: string;
  phone: string;
}

export interface ProgramNode {
  agencyId: string;
  districtScope: "citywide" | "district";
  id: string;
  name: string;
  priority: number;
  requiredRisks: RiskType[];
}

export interface OntologySnapshot {
  agencies: AgencyNode[];
  district: string;
  programs: ProgramNode[];
}

export interface Referral {
  agencyId: string;
  agencyName: string;
  phone: string;
  priority: number;
  programId: string;
  programName: string;
  reason: string;
}

export interface EligibilityResult {
  referrals: Referral[];
}

export interface SafetyResult {
  flags: string[];
  slaMinutes: number;
}

export interface ActionItem {
  channel: "phone" | "sms" | "visit" | "portal";
  details: string;
  dueInHours: number;
  owner: "case-worker" | "citizen";
  step: string;
}

export interface PlanResult {
  actions: ActionItem[];
  fallbackRoute: string;
  summary: string;
}

export interface OutreachMessage {
  agencyName: string;
  message: string;
  phone: string;
}

export interface OutreachResult {
  messages: OutreachMessage[];
}

export interface JudgeResult {
  score: number;
  strengths: string[];
  weaknesses: string[];
}

export interface StagePilotResult {
  eligibility: EligibilityResult;
  intake: NormalizedIntake;
  judge: JudgeResult;
  ontology: OntologySnapshot;
  outreach: OutreachResult;
  plan: PlanResult;
  safety: SafetyResult;
}
