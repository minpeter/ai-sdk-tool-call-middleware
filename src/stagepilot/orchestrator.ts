import {
  EligibilityAgent,
  fallbackNarrative,
  GeminiGateway,
  JudgeAgent,
  type LlmGateway,
  OutreachAgent,
  PlannerAgent,
  readGeminiHttpTimeoutMs,
  SafetyAgent,
} from "./agents";
import { buildOntologySnapshot, normalizeDistrict } from "./ontology";
import type { IntakeInput, NormalizedIntake, StagePilotResult } from "./types";

export interface StagePilotEngineOptions {
  gateway?: LlmGateway;
}

function normalizeIntake(input: IntakeInput): NormalizedIntake {
  const urgency = input.urgencyHint ?? "medium";

  return {
    caseId: input.caseId,
    contactWindow: input.contactWindow ?? "18:00-21:00",
    district: normalizeDistrict(input.district),
    notes: input.notes.trim(),
    risks: input.risks,
    urgency,
  };
}

export class StagePilotEngine {
  private readonly options: StagePilotEngineOptions;
  private readonly eligibilityAgent = new EligibilityAgent();
  private readonly judgeAgent = new JudgeAgent();
  private readonly outreachAgent = new OutreachAgent();
  private readonly plannerAgent = new PlannerAgent();
  private readonly safetyAgent = new SafetyAgent();

  constructor(options: StagePilotEngineOptions = {}) {
    this.options = options;
  }

  async run(input: IntakeInput): Promise<StagePilotResult> {
    const intake = normalizeIntake(input);
    const ontology = buildOntologySnapshot(intake);

    const eligibility = this.eligibilityAgent.run({ intake, ontology });
    const safety = this.safetyAgent.run({ intake });
    const plan = this.plannerAgent.run({ eligibility, intake, safety });
    const outreach = this.outreachAgent.run({ eligibility });
    const judge = this.judgeAgent.run({ eligibility, plan, safety });

    let summary = fallbackNarrative({
      eligibility,
      intake,
      judge,
      ontology,
      outreach,
      plan,
      safety,
    });

    if (this.options.gateway) {
      try {
        summary = await this.options.gateway.summarizePlan({
          intake,
          plan,
          safety,
        });
      } catch {
        // Keep fallback narrative when LLM summarization fails.
      }
    }

    return {
      eligibility,
      intake,
      judge,
      ontology,
      outreach,
      plan: {
        ...plan,
        summary,
      },
      safety,
    };
  }
}

export function createStagePilotEngine(
  apiKey?: string,
  model = "gemini-2.5-pro",
  geminiTimeoutMs?: number
): StagePilotEngine {
  if (!apiKey) {
    return new StagePilotEngine();
  }

  return new StagePilotEngine({
    gateway: new GeminiGateway(apiKey, model, geminiTimeoutMs),
  });
}

export function createStagePilotEngineFromEnv(): StagePilotEngine {
  return createStagePilotEngine(
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_MODEL,
    readGeminiHttpTimeoutMs(process.env.GEMINI_HTTP_TIMEOUT_MS)
  );
}
