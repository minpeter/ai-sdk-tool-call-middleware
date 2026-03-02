import type {
  EligibilityResult,
  JudgeResult,
  NormalizedIntake,
  OntologySnapshot,
  OutreachMessage,
  OutreachResult,
  PlanResult,
  Referral,
  SafetyResult,
  StagePilotResult,
  UrgencyLevel,
} from "./types";

export interface LlmGateway {
  summarizePlan(input: {
    intake: NormalizedIntake;
    plan: PlanResult;
    safety: SafetyResult;
  }): Promise<string>;
}

export const DEFAULT_GEMINI_HTTP_TIMEOUT_MS = 8000;

export function normalizeGeminiHttpTimeoutMs(
  timeoutMs: number | undefined
): number {
  if (
    typeof timeoutMs !== "number" ||
    Number.isNaN(timeoutMs) ||
    !Number.isFinite(timeoutMs)
  ) {
    return DEFAULT_GEMINI_HTTP_TIMEOUT_MS;
  }

  return Math.min(30_000, Math.max(1000, Math.trunc(timeoutMs)));
}

export function readGeminiHttpTimeoutMs(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return DEFAULT_GEMINI_HTTP_TIMEOUT_MS;
  }
  return normalizeGeminiHttpTimeoutMs(parsed);
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: string }).name === "AbortError"
  );
}

async function readJsonWithTimeout<T>(
  response: Response,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      try {
        const body = response.body;
        if (body) {
          body.cancel().catch(() => {
            // best-effort cancellation
          });
        }
      } catch {
        // best-effort cancellation
      }
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([response.json() as Promise<T>, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export class GeminiGateway implements LlmGateway {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(
    apiKey: string,
    model: string,
    timeoutMs = DEFAULT_GEMINI_HTTP_TIMEOUT_MS
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = normalizeGeminiHttpTimeoutMs(timeoutMs);
  }

  async summarizePlan(input: {
    intake: NormalizedIntake;
    plan: PlanResult;
    safety: SafetyResult;
  }): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    const prompt = [
      "Summarize this social-welfare action plan in 3 short bullet points.",
      "Keep it operational and concrete.",
      JSON.stringify(input),
    ].join("\n");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }],
            },
          ],
        }),
        headers: {
          "Content-Type": "application/json",
          "X-goog-api-key": this.apiKey,
        },
        method: "POST",
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(`Gemini request timed out (${this.timeoutMs}ms)`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new Error(`Gemini request failed: ${response.status}`);
    }

    const data = await readJsonWithTimeout<{
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    }>(
      response,
      this.timeoutMs,
      `Gemini response body timed out (${this.timeoutMs}ms)`
    );

    const text = data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("\n")
      .trim();

    if (!text) {
      throw new Error("Gemini response did not include summary text");
    }

    return text;
  }
}

const URGENCY_TO_SLA_MINUTES: Record<UrgencyLevel, number> = {
  high: 120,
  low: 24 * 60,
  medium: 6 * 60,
};

export class EligibilityAgent {
  run(input: {
    intake: NormalizedIntake;
    ontology: OntologySnapshot;
  }): EligibilityResult {
    const agencyById = new Map(
      input.ontology.agencies.map((agency) => [agency.id, agency])
    );

    const referrals: Referral[] = input.ontology.programs
      .slice(0, 3)
      .flatMap((p) => {
        const agency = agencyById.get(p.agencyId);
        if (!agency) {
          return [];
        }

        return [
          {
            agencyId: agency.id,
            agencyName: agency.name,
            phone: agency.phone,
            priority: p.priority,
            programId: p.id,
            programName: p.name,
            reason: `Matched risks: ${input.intake.risks.join(", ")}`,
          },
        ];
      });

    return { referrals };
  }
}

export class SafetyAgent {
  run(input: { intake: NormalizedIntake }): SafetyResult {
    const flags: string[] = [];

    if (input.intake.risks.includes("housing")) {
      flags.push("Housing instability needs same-day escalation.");
    }

    if (input.intake.risks.includes("food")) {
      flags.push("Food insecurity requires immediate hotline routing.");
    }

    if (input.intake.risks.includes("isolation")) {
      flags.push("Isolation risk: plan proactive follow-up contact.");
    }

    return {
      flags,
      slaMinutes: URGENCY_TO_SLA_MINUTES[input.intake.urgency],
    };
  }
}

export class PlannerAgent {
  run(input: {
    eligibility: EligibilityResult;
    intake: NormalizedIntake;
    safety: SafetyResult;
  }): PlanResult {
    const top = input.eligibility.referrals[0];

    const actions = [
      {
        channel: "phone" as const,
        details: "Call 120 to confirm nearest intake desk and opening hours.",
        dueInHours: 1,
        owner: "case-worker" as const,
        step: "Initial hotline routing",
      },
      {
        channel: "phone" as const,
        details:
          "Call 129 and request eligibility screening for emergency support.",
        dueInHours: 2,
        owner: "case-worker" as const,
        step: "Emergency welfare screening",
      },
      {
        channel: "portal" as const,
        details: top
          ? `Prepare referral package for ${top.programName}.`
          : "Prepare district referral package.",
        dueInHours: 6,
        owner: "case-worker" as const,
        step: "District referral handoff",
      },
      {
        channel: "sms" as const,
        details:
          "Send citizen checklist: ID, residence proof, income documents, consent.",
        dueInHours: 6,
        owner: "case-worker" as const,
        step: "Citizen document preparation",
      },
    ];

    const fallbackRoute =
      input.eligibility.referrals.length === 0
        ? "Fallback to citywide hotline-only flow (120 -> 129)."
        : "If district desk unavailable, fallback to 120 then 129 within SLA.";

    return {
      actions,
      fallbackRoute,
      summary: `Plan generated for ${input.intake.district} with ${input.eligibility.referrals.length} referral candidates and SLA ${input.safety.slaMinutes} minutes.`,
    };
  }
}

export class OutreachAgent {
  run(input: { eligibility: EligibilityResult }): OutreachResult {
    const messages: OutreachMessage[] = input.eligibility.referrals.map(
      (ref) => {
        return {
          agencyName: ref.agencyName,
          message: `Hello, this is StagePilot case routing. We have a high-priority case for ${ref.programName}. Please confirm intake requirements and earliest contact window.`,
          phone: ref.phone,
        };
      }
    );

    return { messages };
  }
}

export class JudgeAgent {
  run(input: {
    eligibility: EligibilityResult;
    plan: PlanResult;
    safety: SafetyResult;
  }): JudgeResult {
    const strengths: string[] = [];
    const weaknesses: string[] = [];

    let score = 50;

    if (input.eligibility.referrals.length >= 2) {
      score += 15;
      strengths.push("Multiple referral routes identified.");
    } else {
      weaknesses.push("Referral diversity is limited.");
    }

    if (input.plan.actions.length >= 4) {
      score += 15;
      strengths.push("Action checklist is execution-ready.");
    } else {
      weaknesses.push("Action checklist is too short.");
    }

    if (input.safety.slaMinutes <= 360) {
      score += 20;
      strengths.push("SLA target is strict enough for urgent handling.");
    } else {
      weaknesses.push("SLA target may be too loose for crisis cases.");
    }

    if (score > 100) {
      score = 100;
    }

    return {
      score,
      strengths,
      weaknesses,
    };
  }
}

export function fallbackNarrative(result: StagePilotResult): string {
  return [
    `Case ${result.intake.caseId} routed with urgency ${result.intake.urgency}.`,
    `Primary contacts: ${
      result.eligibility.referrals
        .map((ref) => `${ref.agencyName}(${ref.phone})`)
        .join(", ") || "120, 129"
    }.`,
    `SLA target: ${result.safety.slaMinutes} minutes.`,
  ].join(" ");
}
