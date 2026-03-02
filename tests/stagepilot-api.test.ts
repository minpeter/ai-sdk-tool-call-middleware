import { type AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createStagePilotApiServer } from "../src/api/stagepilot-server";
import { StagePilotEngine } from "../src/stagepilot/orchestrator";

const serversToClose: ReturnType<typeof createStagePilotApiServer>[] = [];
const BODY_TIMEOUT_ENV_KEY = "STAGEPILOT_REQUEST_BODY_TIMEOUT_MS";
const BODY_TIMEOUT_ENV_SNAPSHOT = process.env[BODY_TIMEOUT_ENV_KEY];
const HTTP_STATUS_LINE_REGEX = /^HTTP\/1\.1 (\d{3})/m;

afterEach(async () => {
  await Promise.all(
    serversToClose.splice(0, serversToClose.length).map((server) => {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    })
  );

  if (typeof BODY_TIMEOUT_ENV_SNAPSHOT === "undefined") {
    delete process.env[BODY_TIMEOUT_ENV_KEY];
  } else {
    process.env[BODY_TIMEOUT_ENV_KEY] = BODY_TIMEOUT_ENV_SNAPSHOT;
  }
});

async function startServer(
  options: Parameters<typeof createStagePilotApiServer>[0]
): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createStagePilotApiServer(options);
  serversToClose.push(server);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    close: () => {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function sendStalledPlanRequest(options: {
  bodyChunk: string;
  contentType?: string;
  contentLength: number;
  port: number;
}): Promise<{
  body: string;
  headers: Record<string, string>;
  statusCode: number;
}> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let rawResponse = "";

    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };

    socket.setTimeout(5000, () => {
      fail(new Error("stalled request test socket timeout"));
    });

    socket.connect(options.port, "127.0.0.1", () => {
      const headers = [
        "POST /v1/plan HTTP/1.1",
        `Host: 127.0.0.1:${options.port}`,
        `Content-Type: ${options.contentType ?? "application/json"}`,
        `Content-Length: ${options.contentLength}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n");

      socket.write(headers);
      socket.write(options.bodyChunk);
      // Keep socket open to simulate a client that never finishes body upload.
    });

    socket.on("data", (chunk) => {
      rawResponse += chunk.toString("utf8");
    });

    socket.on("error", (error) => {
      fail(error);
    });

    socket.on("end", () => {
      const [head, body = ""] = rawResponse.split("\r\n\r\n");
      const match = head.match(HTTP_STATUS_LINE_REGEX);
      if (!match) {
        reject(new Error(`unable to parse response: ${rawResponse}`));
        return;
      }

      const headers = Object.fromEntries(
        head
          .split("\r\n")
          .slice(1)
          .map((line) => {
            const separator = line.indexOf(":");
            if (separator < 0) {
              return null;
            }
            const key = line.slice(0, separator).trim().toLowerCase();
            const value = line.slice(separator + 1).trim();
            return [key, value] as const;
          })
          .filter((entry): entry is readonly [string, string] => entry !== null)
      );

      resolve({
        body,
        headers,
        statusCode: Number.parseInt(match[1] ?? "0", 10),
      });
    });
  });
}

function sendTrickledPlanRequest(options: {
  chunks: Array<{
    atMs: number;
    data: string;
  }>;
  contentLength: number;
  port: number;
}): Promise<{
  body: string;
  elapsedMs: number;
  headers: Record<string, string>;
  statusCode: number;
}> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let rawResponse = "";
    const startedAt = Date.now();
    const timers: NodeJS.Timeout[] = [];

    const finish = (
      fn: (value: {
        body: string;
        elapsedMs: number;
        headers: Record<string, string>;
        statusCode: number;
      }) => void,
      value: {
        body: string;
        elapsedMs: number;
        headers: Record<string, string>;
        statusCode: number;
      }
    ) => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      socket.destroy();
      fn(value);
    };

    const fail = (error: Error) => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      socket.destroy();
      reject(error);
    };

    socket.setTimeout(7000, () => {
      fail(new Error("trickled request test socket timeout"));
    });

    socket.connect(options.port, "127.0.0.1", () => {
      const headers = [
        "POST /v1/plan HTTP/1.1",
        `Host: 127.0.0.1:${options.port}`,
        "Content-Type: application/json",
        `Content-Length: ${options.contentLength}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n");

      socket.write(headers);
      for (const chunk of options.chunks) {
        timers.push(
          setTimeout(() => {
            if (!socket.destroyed) {
              socket.write(chunk.data);
            }
          }, chunk.atMs)
        );
      }
      // Do not end socket; keep it open to mimic trickling uploader.
    });

    socket.on("data", (chunk) => {
      rawResponse += chunk.toString("utf8");
    });

    socket.on("error", (error) => {
      fail(error);
    });

    socket.on("end", () => {
      const [head, body = ""] = rawResponse.split("\r\n\r\n");
      const match = head.match(HTTP_STATUS_LINE_REGEX);
      if (!match) {
        reject(new Error(`unable to parse response: ${rawResponse}`));
        return;
      }

      const headers = Object.fromEntries(
        head
          .split("\r\n")
          .slice(1)
          .map((line) => {
            const separator = line.indexOf(":");
            if (separator < 0) {
              return null;
            }
            const key = line.slice(0, separator).trim().toLowerCase();
            const value = line.slice(separator + 1).trim();
            return [key, value] as const;
          })
          .filter((entry): entry is readonly [string, string] => entry !== null)
      );

      finish(resolve, {
        body,
        elapsedMs: Date.now() - startedAt,
        headers,
        statusCode: Number.parseInt(match[1] ?? "0", 10),
      });
    });
  });
}

describe("stagepilot api server", () => {
  it("serves desktop demo page", async () => {
    const { baseUrl } = await startServer({
      engine: new StagePilotEngine(),
    });

    const response = await fetch(`${baseUrl}/demo`);
    expect(response.status).toBe(200);

    const contentType = response.headers.get("content-type") ?? "";
    expect(contentType).toContain("text/html");

    const html = await response.text();
    expect(html).toContain("StagePilot Judge Console");
    expect(html).toContain("/v1/whatif");
  });

  it("returns health response", async () => {
    const { baseUrl } = await startServer({
      engine: new StagePilotEngine(),
    });

    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      ok: boolean;
      service: string;
      useGpu: boolean;
    };

    expect(body.ok).toBe(true);
    expect(body.service).toBeTypeOf("string");
    expect(body.useGpu).toBe(false);
  });

  it("runs planning endpoint", async () => {
    const { baseUrl } = await startServer({
      engine: new StagePilotEngine(),
    });

    const response = await fetch(`${baseUrl}/v1/plan`, {
      body: JSON.stringify({
        caseId: "api-001",
        district: "Gangbuk-gu",
        notes: "Rent overdue, food instability",
        risks: ["housing", "food", "income"],
        urgencyHint: "high",
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      result: {
        plan: {
          actions: unknown[];
        };
      };
    };

    expect(body.ok).toBe(true);
    expect(body.result.plan.actions.length).toBeGreaterThanOrEqual(4);
  });

  it("returns 400 for invalid input body", async () => {
    const { baseUrl } = await startServer({
      engine: new StagePilotEngine(),
    });

    const response = await fetch(`${baseUrl}/v1/plan`, {
      body: JSON.stringify({
        district: "Gangbuk-gu",
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("returns 400 for malformed json body", async () => {
    const { baseUrl } = await startServer({
      engine: new StagePilotEngine(),
    });

    const response = await fetch(`${baseUrl}/v1/plan`, {
      body: '{"caseId":',
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      ok: boolean;
    };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("invalid JSON");
  });

  it("returns 413 for oversized body", async () => {
    const { baseUrl } = await startServer({
      engine: new StagePilotEngine(),
    });
    const huge = "x".repeat(1_100_000);

    const response = await fetch(`${baseUrl}/v1/plan`, {
      body: huge,
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(413);
    const body = (await response.json()) as {
      error: string;
      ok: boolean;
    };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("too large");
  });

  it("returns 415 when content type is not json", async () => {
    const { baseUrl } = await startServer({
      engine: new StagePilotEngine(),
    });

    const response = await fetch(`${baseUrl}/v1/plan`, {
      body: "caseId=1",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(415);
  });

  it("returns 415 and closes connection for non-json request with pending body", async () => {
    const { baseUrl } = await startServer({
      engine: new StagePilotEngine(),
    });
    const port = Number.parseInt(new URL(baseUrl).port, 10);

    const response = await sendStalledPlanRequest({
      bodyChunk: "caseId=still-uploading",
      contentLength: 1024,
      contentType: "text/plain",
      port,
    });

    expect(response.statusCode).toBe(415);
    expect((response.headers.connection ?? "").toLowerCase()).toBe("close");
    const parsed = JSON.parse(response.body) as {
      error: string;
      ok: boolean;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("content-type");
  }, 7000);

  it("returns 413 and closes connection for oversized upload", async () => {
    const { baseUrl } = await startServer({
      engine: new StagePilotEngine(),
    });
    const port = Number.parseInt(new URL(baseUrl).port, 10);

    const response = await sendStalledPlanRequest({
      bodyChunk: "x".repeat(1_100_000),
      contentLength: 1_200_000,
      port,
    });

    expect(response.statusCode).toBe(413);
    expect((response.headers.connection ?? "").toLowerCase()).toBe("close");
    const parsed = JSON.parse(response.body) as {
      error: string;
      ok: boolean;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("too large");
  }, 9000);

  it("returns 408 when request body upload stalls", async () => {
    process.env.STAGEPILOT_REQUEST_BODY_TIMEOUT_MS = "1000";
    const { baseUrl } = await startServer({
      engine: new StagePilotEngine(),
    });
    const port = Number.parseInt(new URL(baseUrl).port, 10);

    const response = await sendStalledPlanRequest({
      bodyChunk: '{"caseId":"stalling-upload"',
      contentLength: 256,
      port,
    });

    expect(response.statusCode).toBe(408);
    expect((response.headers.connection ?? "").toLowerCase()).toBe("close");
    const parsed = JSON.parse(response.body) as {
      error: string;
      ok: boolean;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("request body timeout");
  }, 7000);

  it("returns 408 when upload trickles beyond total timeout budget", async () => {
    process.env.STAGEPILOT_REQUEST_BODY_TIMEOUT_MS = "1200";
    const { baseUrl } = await startServer({
      engine: new StagePilotEngine(),
    });
    const port = Number.parseInt(new URL(baseUrl).port, 10);

    const response = await sendTrickledPlanRequest({
      chunks: [
        { atMs: 0, data: '{"caseId":"slow-1",' },
        { atMs: 500, data: '"district":"Gangbuk-gu",' },
        { atMs: 1000, data: '"notes":"delayed"' },
      ],
      contentLength: 1024,
      port,
    });

    expect(response.statusCode).toBe(408);
    expect((response.headers.connection ?? "").toLowerCase()).toBe("close");
    expect(response.elapsedMs).toBeLessThan(1800);
    const parsed = JSON.parse(response.body) as {
      error: string;
      ok: boolean;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("request body timeout");
  }, 9000);

  it("returns benchmark report from benchmark endpoint", async () => {
    const { baseUrl } = await startServer({
      benchmarkRunner: () =>
        Promise.resolve({
          caseCount: 2,
          generatedAt: "2026-02-28T00:00:00.000Z",
          improvements: {
            loopVsBaseline: 20,
            loopVsMiddleware: 10,
            middlewareVsBaseline: 10,
          },
          seed: 1,
          strategies: [],
        }),
      engine: new StagePilotEngine(),
    });

    const response = await fetch(`${baseUrl}/v1/benchmark`, {
      body: JSON.stringify({ caseCount: 2 }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      report: {
        caseCount: number;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.report.caseCount).toBe(2);
  });

  it("returns ontology insights from insights endpoint", async () => {
    const { baseUrl } = await startServer({
      engine: new StagePilotEngine(),
      insightDeriver: () =>
        Promise.resolve({
          kpis: {
            judgeScore: 88,
            referralCount: 2,
            slaMinutes: 120,
            topPrograms: ["Emergency Livelihood Support"],
          },
          narrative: "- insight 1\n- insight 2\n- insight 3",
          source: "gemini",
        }),
    });

    const response = await fetch(`${baseUrl}/v1/insights`, {
      body: JSON.stringify({
        caseId: "api-insight-001",
        district: "Gangbuk-gu",
        notes: "Need routing",
        risks: ["food", "income"],
        urgencyHint: "high",
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      insights: {
        source: string;
      };
      ok: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.insights.source).toBe("gemini");
  });

  it("returns what-if simulation from twin endpoint", async () => {
    const { baseUrl } = await startServer({
      engine: new StagePilotEngine(),
    });

    const response = await fetch(`${baseUrl}/v1/whatif`, {
      body: JSON.stringify({
        caseId: "api-whatif-001",
        district: "Jungnang-gu",
        notes: "Need rapid routing with limited staffing",
        risks: ["food", "isolation"],
        profile: {
          caseWorkers: 7,
          demandPerHour: 10.2,
        },
        scenario: {
          demandDeltaPct: 20,
          staffingDeltaPct: -15,
        },
        urgencyHint: "high",
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      ok: boolean;
      twin: {
        alternatives: unknown[];
        profile: {
          caseWorkers: number;
        };
        recommendation: unknown | null;
        scenario: {
          demandDeltaPct: number;
          staffingDeltaPct: number;
        };
        simulated: {
          expectedFirstContactMinutes: number;
          slaBreachProbability: number;
        };
      };
    };

    expect(body.ok).toBe(true);
    expect(body.twin.scenario.staffingDeltaPct).toBe(-15);
    expect(body.twin.scenario.demandDeltaPct).toBe(20);
    expect(body.twin.profile.caseWorkers).toBe(7);
    expect(body.twin.simulated.expectedFirstContactMinutes).toBeGreaterThan(0);
    expect(body.twin.simulated.slaBreachProbability).toBeGreaterThanOrEqual(0);
    expect(body.twin.alternatives.length).toBeGreaterThan(0);
    expect(body.twin.recommendation).not.toBeNull();
  });

  it("returns 400 for invalid what-if scenario", async () => {
    const { baseUrl } = await startServer({
      engine: new StagePilotEngine(),
    });

    const response = await fetch(`${baseUrl}/v1/whatif`, {
      body: JSON.stringify({
        caseId: "api-whatif-002",
        district: "Gangbuk-gu",
        notes: "Invalid scenario payload",
        risks: ["food"],
        scenario: {
          staffingDeltaPct: "fast",
        },
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      ok: boolean;
    };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("scenario.staffingDeltaPct");
  });

  it("returns 400 for invalid what-if profile", async () => {
    const { baseUrl } = await startServer({
      engine: new StagePilotEngine(),
    });

    const response = await fetch(`${baseUrl}/v1/whatif`, {
      body: JSON.stringify({
        caseId: "api-whatif-003",
        district: "Gangbuk-gu",
        notes: "Invalid profile payload",
        profile: {
          caseWorkers: "many",
        },
        risks: ["housing", "income"],
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      ok: boolean;
    };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("profile.caseWorkers");
  });

  it("returns delivery result from notify endpoint", async () => {
    const { baseUrl } = await startServer({
      engine: new StagePilotEngine(),
      openClawNotifier: () =>
        Promise.resolve({
          channel: "telegram",
          delivered: true,
          detail: "sent",
          mode: "cli",
          target: "@welfare-ops",
        }),
    });

    const response = await fetch(`${baseUrl}/v1/notify`, {
      body: JSON.stringify({
        caseId: "api-notify-001",
        delivery: {
          channel: "telegram",
          dryRun: false,
          target: "@welfare-ops",
        },
        district: "Gangbuk-gu",
        notes: "Need immediate dispatch",
        risks: ["food", "housing"],
        urgencyHint: "high",
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      delivery: {
        delivered: boolean;
        mode: string;
      };
      ok: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.delivery.delivered).toBe(true);
    expect(body.delivery.mode).toBe("cli");
  });

  it("returns 400 for invalid notify delivery payload", async () => {
    const { baseUrl } = await startServer({
      engine: new StagePilotEngine(),
    });

    const response = await fetch(`${baseUrl}/v1/notify`, {
      body: JSON.stringify({
        caseId: "api-notify-002",
        delivery: {
          dryRun: "yes",
        },
        district: "Gangbuk-gu",
        notes: "Need immediate dispatch",
        risks: ["food"],
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      ok: boolean;
    };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("delivery.dryRun");
  });

  it("handles openclaw inbox insights command and replies", async () => {
    let capturedMessage = "";
    const { baseUrl } = await startServer({
      engine: new StagePilotEngine(),
      insightDeriver: () =>
        Promise.resolve({
          kpis: {
            judgeScore: 93,
            referralCount: 2,
            slaMinutes: 120,
            topPrograms: ["Emergency Livelihood Support"],
          },
          narrative: "insight summary",
          source: "fallback",
        }),
      openClawNotifier: (input) => {
        capturedMessage = input.message ?? "";
        return Promise.resolve({
          channel: "telegram",
          delivered: false,
          detail: "dry run",
          mode: "dry-run",
          target: "@welfare-ops",
        });
      },
    });

    const response = await fetch(`${baseUrl}/v1/openclaw/inbox`, {
      body: JSON.stringify({
        delivery: {
          channel: "telegram",
          dryRun: true,
          target: "@welfare-ops",
        },
        message: "/insights single resident needs fast routing",
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      action: string;
      delivery?: { mode: string };
      insights?: { narrative: string };
      ok: boolean;
      result: { intake: { notes: string } };
    };
    expect(body.ok).toBe(true);
    expect(body.action).toBe("insights");
    expect(body.insights?.narrative).toContain("insight");
    expect(body.delivery?.mode).toBe("dry-run");
    expect(body.result.intake.notes).toContain("single resident");
    expect(capturedMessage).toContain("[StagePilot Inbox]");
  });

  it("returns 400 for invalid openclaw inbox command", async () => {
    const { baseUrl } = await startServer({
      engine: new StagePilotEngine(),
    });

    const response = await fetch(`${baseUrl}/v1/openclaw/inbox`, {
      body: JSON.stringify({
        command: "dispatch-now",
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      ok: boolean;
    };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("plan|insights|whatif");
  });
});
