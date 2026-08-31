import { describe, expect, it } from "vitest";
import {
  PROVIDER_CAPTURE_FORMAT_VERSION,
  type ProviderCaptureRecord,
} from "./provider-capture";
import {
  parseCapturedSseChunks,
  replayParserMode,
  replayProviderCaptureResponse,
} from "./replay-provider-capture-core";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const tools = [
  {
    inputSchema: {
      additionalProperties: false,
      properties: { city: { type: "string" } },
      required: ["city"],
      type: "object",
    },
    name: "lookup",
    originalName: "lookup",
  },
];

function capture(options: {
  arm: string;
  body: string;
  contentType?: string;
  transport: "generate" | "stream";
}): ProviderCaptureRecord {
  return {
    capturedAt: "2026-07-17T00:00:00.000Z",
    captureId: `${options.arm}-${options.transport}`,
    context: {
      arm: options.arm,
      attempt: 1,
      caseId: "offline-case",
      jobKey: `offline-case\u0000${options.arm}\u00001`,
      suite: "bfcl",
      tools,
      transport: options.transport,
      trial: 1,
    },
    formatVersion: PROVIDER_CAPTURE_FORMAT_VERSION,
    request: {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
      url: "https://provider.invalid/v1/chat/completions",
    },
    response: {
      body: options.body,
      headers: {
        "content-type":
          options.contentType ??
          (options.transport === "stream"
            ? "text/event-stream"
            : "application/json"),
      },
      status: 200,
      statusText: "OK",
    },
  };
}

function generateBody(options: { arguments?: string; text?: string }): string {
  return JSON.stringify({
    choices: [
      {
        finish_reason: options.arguments ? "tool_calls" : "stop",
        message: {
          content: options.text ?? null,
          tool_calls:
            options.arguments === undefined
              ? undefined
              : [
                  {
                    function: {
                      arguments: options.arguments,
                      name: "lookup",
                    },
                    id: "native-1",
                    type: "function",
                  },
                ],
        },
      },
    ],
  });
}

function sseData(value: unknown): string {
  return `data: ${JSON.stringify(value)}\r\n\r\n`;
}

describe("provider capture response replay", () => {
  it("maps auto to the current benchmark response semantics", () => {
    expect(replayParserMode("native", "auto")).toBe("native");
    expect(replayParserMode("glm5", "auto")).toBe("glm5");
    expect(() => replayParserMode("hermes", "auto")).toThrow(
      "has no response semantics"
    );
  });

  it("leaves the same double-encoded call untouched in plain Native", async () => {
    const inner = '{"city": Seoul}';
    const replay = await replayProviderCaptureResponse(
      capture({
        arm: "native",
        body: generateBody({ arguments: JSON.stringify(inner) }),
        transport: "generate",
      }),
      "auto"
    );

    expect(replay.calls[0]?.arguments).toBe(inner);
    expect(replay.parser).toBe("native");
  });

  it("replays the GLM generate text fallback", async () => {
    const replay = await replayProviderCaptureResponse(
      capture({
        arm: "glm5",
        body: generateBody({ text: 'lookup(city="Seoul")' }),
        transport: "generate",
      }),
      "auto"
    );

    expect(replay.parser).toBe("glm5");
    expect(replay.calls[0]?.arguments).toEqual({ city: "Seoul" });
    expect(replay.text).toBe("");
  });

  it("uses the production prompt-only transform for captured SSE and validates re-chunking", async () => {
    const canonical =
      "<tool_call>lookup<arg_key>city</arg_key><arg_value>Seoul</arg_value></tool_call>";
    const body = [
      sseData({ choices: [{ delta: { content: canonical.slice(0, 11) } }] }),
      sseData({ choices: [{ delta: { content: canonical.slice(11) } }] }),
      sseData({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]\r\n\r\n",
    ].join("");
    const errors: string[] = [];

    const replay = await replayProviderCaptureResponse(
      capture({ arm: "glm5", body, transport: "stream" }),
      "auto",
      errors
    );

    expect(replay.calls).toEqual([
      {
        arguments: { city: "Seoul" },
        name: "lookup",
        safeName: "lookup",
      },
    ]);
    expect(replay.text).toBe("");
    expect(replay.chunkInvariance).toMatchObject({
      checked: true,
      sseByteChunkVariants: 9,
      streamDeltaChunkVariants: 9,
    });
    expect(replay.chunkInvariance.normalizedSnapshotSha256).toMatch(
      SHA256_PATTERN
    );
    expect(errors).toEqual([]);
  });

  it("decodes identical SSE payloads at every possible two-chunk boundary", () => {
    const body = `${sseData({ choices: [{ delta: { content: "서울" } }] })}data: [DONE]\r\n\r\n`;
    const expected = parseCapturedSseChunks([body]);

    for (let boundary = 0; boundary <= body.length; boundary += 1) {
      const errors: string[] = [];
      expect(
        parseCapturedSseChunks(
          [body.slice(0, boundary), body.slice(boundary)],
          errors
        )
      ).toEqual(expected);
      expect(errors).toEqual([]);
    }
  });
});
