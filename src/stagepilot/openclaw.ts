import { spawnSync } from "node:child_process";
import type { StagePilotTwinResult } from "./twin";
import type { StagePilotResult } from "./types";

export interface StagePilotOpenClawTarget {
  channel?: string;
  target?: string;
  threadId?: string;
}

export interface StagePilotOpenClawNotifyInput {
  dryRun?: boolean;
  message?: string;
  result: StagePilotResult;
  target?: StagePilotOpenClawTarget;
  twin?: StagePilotTwinResult;
}

export interface StagePilotOpenClawNotifyResult {
  channel: string | null;
  delivered: boolean;
  detail: string;
  mode:
    | "cli"
    | "disabled"
    | "dry-run"
    | "failed"
    | "not-configured"
    | "webhook";
  statusCode?: number;
  target: string | null;
}

export type StagePilotOpenClawNotifier = (
  input: StagePilotOpenClawNotifyInput
) => Promise<StagePilotOpenClawNotifyResult>;

function isTruthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function truncateText(value: string, max = 200): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 3)}...`;
}

function toNonEmpty(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readCliTimeoutMs(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return 5000;
  }
  return Math.min(30_000, Math.max(1000, parsed));
}

function readWebhookTimeoutMs(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return 5000;
  }
  return Math.min(30_000, Math.max(1000, parsed));
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: string }).name === "AbortError"
  );
}

async function readResponseTextWithTimeout(
  response: Response,
  timeoutMs: number
): Promise<string> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<string>((resolve) => {
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
      resolve("[response body timed out]");
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      response
        .text()
        .catch((error) => `[response body read error: ${String(error)}]`),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export function formatStagePilotOpenClawMessage(input: {
  result: StagePilotResult;
  twin?: StagePilotTwinResult;
}): string {
  const { result, twin } = input;
  const topReferrals = result.eligibility.referrals.slice(0, 3);
  const firstActions = result.plan.actions.slice(0, 3);

  const topReferralLine =
    topReferrals.length === 0
      ? "Top routes: no referral candidates"
      : `Top routes: ${topReferrals
          .map(
            (referral) =>
              `${referral.agencyName} (${referral.phone}) [${referral.priority}]`
          )
          .join(" | ")}`;

  const actionLines =
    firstActions.length === 0
      ? ["- No immediate actions generated"]
      : firstActions.map(
          (action) =>
            `- ${action.step}: ${action.details} (due ${action.dueInHours}h)`
        );

  const twinLine = twin?.recommendation
    ? `Twin recommendation: ${twin.recommendation.agencyName} (${twin.recommendation.phone}), wait ${twin.recommendation.expectedWaitMinutes}m, breach ${Math.round(twin.recommendation.slaBreachProbability * 100)}%`
    : "Twin recommendation: unavailable";

  return [
    `[StagePilot] Case ${result.intake.caseId}`,
    `District: ${result.intake.district} | Urgency: ${result.intake.urgency} | Judge score: ${result.judge.score}`,
    `Risks: ${result.intake.risks.join(", ") || "none"}`,
    topReferralLine,
    "Immediate actions:",
    ...actionLines,
    twinLine,
    `SLA target: ${result.safety.slaMinutes}m`,
  ].join("\n");
}

async function sendViaWebhook(options: {
  apiKey: string | null;
  channel: string | null;
  message: string;
  target: string | null;
  targetThreadId: string | null;
  timeoutMs: number;
  url: string;
}): Promise<StagePilotOpenClawNotifyResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options.apiKey) {
    headers.Authorization = `Bearer ${options.apiKey}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);
  let response: Response;
  try {
    response = await fetch(options.url, {
      body: JSON.stringify({
        channel: options.channel,
        message: options.message,
        target: options.target,
        threadId: options.targetThreadId,
      }),
      headers,
      method: "POST",
      signal: controller.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      return {
        channel: options.channel,
        delivered: false,
        detail: `webhook timeout (${options.timeoutMs}ms)`,
        mode: "failed",
        target: options.target,
      };
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const text = truncateText(
      await readResponseTextWithTimeout(response, options.timeoutMs)
    );
    return {
      channel: options.channel,
      delivered: false,
      detail: `webhook responded ${response.status}: ${text}`,
      mode: "failed",
      statusCode: response.status,
      target: options.target,
    };
  }

  return {
    channel: options.channel,
    delivered: true,
    detail: `webhook delivered (${response.status})`,
    mode: "webhook",
    statusCode: response.status,
    target: options.target,
  };
}

function sendViaCli(options: {
  channel: string | null;
  cliCommand: string;
  message: string;
  target: string | null;
  timeoutMs: number;
  targetThreadId: string | null;
}): StagePilotOpenClawNotifyResult {
  if (!options.target) {
    return {
      channel: options.channel,
      delivered: false,
      detail: "cli mode requires target",
      mode: "not-configured",
      target: options.target,
    };
  }

  const args = ["message", "send"];
  if (options.channel) {
    args.push("--channel", options.channel);
  }
  args.push("--target", options.target, "--message", options.message, "--json");
  if (options.targetThreadId) {
    args.push("--thread-id", options.targetThreadId);
  }

  const command = spawnSync(options.cliCommand, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: options.timeoutMs,
  });

  if (command.error) {
    const notFound =
      typeof command.error === "object" &&
      command.error !== null &&
      "code" in command.error &&
      (command.error as { code?: string }).code === "ENOENT";
    const timedOut =
      typeof command.error === "object" &&
      command.error !== null &&
      "code" in command.error &&
      (command.error as { code?: string }).code === "ETIMEDOUT";

    if (notFound) {
      return {
        channel: options.channel,
        delivered: false,
        detail: `${options.cliCommand} not found`,
        mode: "not-configured",
        target: options.target,
      };
    }

    if (timedOut) {
      return {
        channel: options.channel,
        delivered: false,
        detail: `cli timeout (${options.timeoutMs}ms)`,
        mode: "failed",
        target: options.target,
      };
    }

    return {
      channel: options.channel,
      delivered: false,
      detail: `cli error: ${truncateText(String(command.error))}`,
      mode: "failed",
      target: options.target,
    };
  }

  if (command.status === 0) {
    return {
      channel: options.channel,
      delivered: true,
      detail: "cli delivered",
      mode: "cli",
      target: options.target,
    };
  }

  return {
    channel: options.channel,
    delivered: false,
    detail: truncateText(command.stderr || command.stdout || "cli failed"),
    mode: "failed",
    target: options.target,
  };
}

export function createStagePilotOpenClawNotifierFromEnv(): StagePilotOpenClawNotifier {
  const enabled = isTruthy(process.env.OPENCLAW_ENABLED);
  const defaultChannel = toNonEmpty(process.env.OPENCLAW_CHANNEL);
  const defaultTarget = toNonEmpty(process.env.OPENCLAW_TARGET);
  const defaultThreadId = toNonEmpty(process.env.OPENCLAW_THREAD_ID);
  const webhookUrl = toNonEmpty(process.env.OPENCLAW_WEBHOOK_URL);
  const apiKey = toNonEmpty(process.env.OPENCLAW_API_KEY);
  const cliCommand = toNonEmpty(process.env.OPENCLAW_CMD) ?? "openclaw";
  const cliTimeoutMs = readCliTimeoutMs(process.env.OPENCLAW_CLI_TIMEOUT_MS);
  const webhookTimeoutMs = readWebhookTimeoutMs(
    process.env.OPENCLAW_WEBHOOK_TIMEOUT_MS
  );

  return async (input) => {
    const channel = toNonEmpty(input.target?.channel) ?? defaultChannel;
    const target = toNonEmpty(input.target?.target) ?? defaultTarget;
    const targetThreadId =
      toNonEmpty(input.target?.threadId) ?? defaultThreadId;

    const text = truncateText(
      toNonEmpty(input.message) ??
        formatStagePilotOpenClawMessage({
          result: input.result,
          twin: input.twin,
        }),
      4000
    );

    if (input.dryRun) {
      return {
        channel,
        delivered: false,
        detail: "dry run: payload validated",
        mode: "dry-run",
        target,
      };
    }

    if (!enabled) {
      return {
        channel,
        delivered: false,
        detail: "OPENCLAW_ENABLED=0",
        mode: "disabled",
        target,
      };
    }

    if (webhookUrl) {
      try {
        return await sendViaWebhook({
          apiKey,
          channel,
          message: text,
          target,
          targetThreadId,
          timeoutMs: webhookTimeoutMs,
          url: webhookUrl,
        });
      } catch (error) {
        return {
          channel,
          delivered: false,
          detail: `webhook error: ${truncateText(String(error))}`,
          mode: "failed",
          target,
        };
      }
    }

    return sendViaCli({
      channel,
      cliCommand,
      message: text,
      target,
      timeoutMs: cliTimeoutMs,
      targetThreadId,
    });
  };
}
