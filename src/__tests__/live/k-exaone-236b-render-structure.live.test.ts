import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4Middleware,
  LanguageModelV4Prompt,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { kExaone236BToolMiddleware } from "../../preconfigured-middleware";
import {
  captureProviderBody,
  edgeProbeTools,
} from "../entry/provider-capture.shared";

const { FRIENDLI_API_KEY } = process.env;
const FRIENDLI_BASE_URL = "https://api.friendli.ai/serverless/v1";
const MODEL_ID = "LGAI-EXAONE/K-EXAONE-236B-A23B";

const capturedBodySchema = z.object({
  messages: z.array(z.record(z.string(), z.json())),
  tools: z.array(z.record(z.string(), z.json())).optional(),
});
const renderResponseSchema = z.object({ text: z.string() });

const tools = edgeProbeTools();

const multiTools = [
  {
    type: "function",
    name: "inspect_payload",
    description: "Inspect a nested payload with Unicode labels.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: 'Quoted "label" with 한글.' },
        nested: {
          type: "object",
          properties: {
            order: {
              type: "array",
              items: {
                anyOf: [
                  { type: "string" },
                  {
                    type: "object",
                    properties: { count: { type: "number" } },
                    required: ["count"],
                  },
                ],
              },
            },
          },
          required: ["order"],
        },
      },
      required: ["label", "nested"],
    },
  },
  {
    type: "function",
    name: "record_payload",
    description: "Record a payload status across paths /a/b and line\nbreaks.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["ready", "done"] },
      },
      required: ["status"],
    },
  },
] as const satisfies readonly LanguageModelV4FunctionTool[];

interface CaptureOptions {
  readonly middleware?: LanguageModelV4Middleware;
  readonly prompt: LanguageModelV4Prompt;
  readonly tools?: readonly LanguageModelV4FunctionTool[];
}

function captureFriendliBody(options: CaptureOptions) {
  return captureProviderBody({
    name: "friendli-capture",
    apiKey: "capture-only",
    baseURL: "https://capture.invalid/v1",
    modelId: MODEL_ID,
    middleware: options.middleware,
    prompt: options.prompt,
    tools: options.tools ?? tools,
    parseBody: (source) => capturedBodySchema.parse(JSON.parse(source)),
  });
}

async function renderFriendli(options: {
  readonly body: z.infer<typeof capturedBodySchema>;
  readonly enableThinking: boolean;
}): Promise<string> {
  if (FRIENDLI_API_KEY === undefined) {
    throw new TypeError("FRIENDLI_API_KEY is required for this live test");
  }
  const response = await fetch(`${FRIENDLI_BASE_URL}/chat/render`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${FRIENDLI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL_ID,
      ...options.body,
      chat_template_kwargs: {
        enable_thinking: options.enableThinking,
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new TypeError(`Friendli render failed with HTTP ${response.status}`);
  }
  return renderResponseSchema.parse(await response.json()).text;
}

const describeLive = FRIENDLI_API_KEY ? describe : describe.skip;

const benchmarkScenarios: Array<{
  readonly id: string;
  readonly enableThinking: boolean;
  readonly prompt: LanguageModelV4Prompt;
  readonly tools?: readonly LanguageModelV4FunctionTool[];
}> = [
  {
    id: "no-system-thinking-on",
    enableThinking: true,
    prompt: [
      {
        role: "user",
        content: [{ type: "text", text: "Run the probe." }],
      },
    ],
  },
  {
    id: "no-system-thinking-off",
    enableThinking: false,
    prompt: [
      {
        role: "user",
        content: [{ type: "text", text: "Run the probe." }],
      },
    ],
  },
  {
    id: "system-thinking-on",
    enableThinking: true,
    prompt: [
      { role: "system", content: "SYSTEM_SENTINEL" },
      {
        role: "user",
        content: [{ type: "text", text: "Run the probe." }],
      },
    ],
  },
  {
    id: "system-thinking-off",
    enableThinking: false,
    prompt: [
      { role: "system", content: "SYSTEM_SENTINEL" },
      {
        role: "user",
        content: [{ type: "text", text: "Run the probe." }],
      },
    ],
  },
  {
    id: "multiple-tools-complex-schema",
    enableThinking: true,
    tools: multiTools,
    prompt: [
      {
        role: "user",
        content: [{ type: "text", text: "Inspect and record this payload." }],
      },
    ],
  },
  {
    id: "unicode-and-escaping",
    enableThinking: false,
    tools: multiTools,
    prompt: [
      { role: "system", content: '시스템 "인용" / 경로\n다음 줄' },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: '서울 payload: {"path":"/a/b","note":"line\\nbreak"}',
          },
        ],
      },
    ],
  },
  {
    id: "reasoning-single-call-history",
    enableThinking: true,
    prompt: [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "reasoning sentinel" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "edge_probe",
            input: { zed: 1e-7, alpha: 1, raw: "서울" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "edge_probe",
            output: { type: "json", value: { ok: true, city: "서울" } },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Continue after inspection." }],
      },
    ],
  },
  {
    id: "parallel-two-call-history",
    enableThinking: false,
    tools: multiTools,
    prompt: [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-inspect",
            toolName: "inspect_payload",
            input: {
              label: "서울",
              nested: { order: ["alpha", { count: 2 }] },
            },
          },
          {
            type: "tool-call",
            toolCallId: "call-record",
            toolName: "record_payload",
            input: { status: "done" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-inspect",
            toolName: "inspect_payload",
            output: {
              type: "json",
              value: {
                label: "서울",
                nested: { order: ["alpha", { count: 2 }] },
              },
            },
          },
          {
            type: "tool-result",
            toolCallId: "call-record",
            toolName: "record_payload",
            output: { type: "text", value: "recorded:done" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Summarize both results." }],
      },
    ],
  },
];

describeLive("K-EXAONE-236B Friendli render benchmark", () => {
  it.each(benchmarkScenarios)(
    "$id preserves the native declaration before the Hermes guide",
    async (scenario) => {
      const nativeBody = await captureFriendliBody({
        prompt: scenario.prompt,
        tools: scenario.tools,
      });
      const middlewareBody = await captureFriendliBody({
        middleware: kExaone236BToolMiddleware,
        prompt: scenario.prompt,
        tools: scenario.tools,
      });
      const nativeStartedAt = performance.now();
      const native = await renderFriendli({
        body: nativeBody,
        enableThinking: scenario.enableThinking,
      });
      const nativeDurationMs = performance.now() - nativeStartedAt;
      const middlewareStartedAt = performance.now();
      const middleware = await renderFriendli({
        body: middlewareBody,
        enableThinking: scenario.enableThinking,
      });
      const middlewareDurationMs = performance.now() - middlewareStartedAt;

      const turnBoundary = "<|endofturn|>\n";
      const nativeDeclarationEnd =
        native.indexOf(turnBoundary) + turnBoundary.length;
      const middlewareGuideStart = middleware.indexOf("<|system|>");
      const nativeDeclarationBytes = new TextEncoder().encode(
        native.slice(0, nativeDeclarationEnd)
      );
      const middlewareDeclarationBytes = new TextEncoder().encode(
        middleware.slice(0, middlewareGuideStart)
      );

      expect(nativeDeclarationEnd).toBeGreaterThan(turnBoundary.length - 1);
      expect(middlewareGuideStart).toBe(nativeDeclarationEnd);
      expect(middlewareDeclarationBytes).toEqual(nativeDeclarationBytes);
      expect(middleware).toContain(
        "# Tool Call Format\nWhen calling a tool, output exactly one JSON object inside <tool_call> tags:"
      );
      expect(middleware).toContain(
        '<tool_call>{"name":"example_tool_name","arguments":{"arg1":"value1"}}</tool_call>'
      );
      expect(middleware.indexOf("<|system|>")).toBeLessThan(
        middleware.indexOf("<|user|>")
      );
      expect(nativeDurationMs).toBeLessThan(30_000);
      expect(middlewareDurationMs).toBeLessThan(30_000);
    }
  );
});
