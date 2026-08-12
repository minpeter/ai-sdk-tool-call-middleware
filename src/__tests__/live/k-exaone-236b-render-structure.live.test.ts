import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4Middleware,
  LanguageModelV4Prompt,
} from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { kExaone236BToolMiddleware } from "../../preconfigured-middleware";

const { FRIENDLI_API_KEY } = process.env;
const FRIENDLI_BASE_URL = "https://api.friendli.ai/serverless/v1";
const MODEL_ID = "LGAI-EXAONE/K-EXAONE-236B-A23B";

const capturedBodySchema = z.object({
  messages: z.array(z.record(z.string(), z.unknown())),
  tools: z.array(z.record(z.string(), z.unknown())).optional(),
});
const renderResponseSchema = z.object({ text: z.string() });

const tools = [
  {
    type: "function",
    name: "edge_probe",
    description: "Probe exact JSON rendering.",
    inputSchema: {
      type: "object",
      properties: {
        zed: { type: "number", minimum: 1e-7, maximum: 1e21 },
        alpha: { type: "integer" },
        raw: { type: "string" },
      },
      required: ["zed"],
      additionalProperties: false,
    },
    strict: true,
  },
] satisfies LanguageModelV4FunctionTool[];

interface CaptureOptions {
  readonly middleware?: LanguageModelV4Middleware;
  readonly prompt: LanguageModelV4Prompt;
}

async function captureProviderBody(
  options: CaptureOptions
): Promise<z.infer<typeof capturedBodySchema>> {
  let body: unknown;
  const provider = createOpenAICompatible({
    name: "friendli-capture",
    apiKey: "capture-only",
    baseURL: "https://capture.invalid/v1",
    fetch: (_input, init) => {
      if (typeof init?.body !== "string") {
        throw new TypeError("Expected a JSON request body");
      }
      body = JSON.parse(init.body);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "capture",
            created: 0,
            model: MODEL_ID,
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: "done" },
              },
            ],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 1,
              total_tokens: 2,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        )
      );
    },
  });
  const rawModel = provider.chatModel(MODEL_ID);
  const model = options.middleware
    ? wrapLanguageModel({ model: rawModel, middleware: options.middleware })
    : rawModel;

  await model.doGenerate({ prompt: options.prompt, tools });
  return capturedBodySchema.parse(body);
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

describeLive("K-EXAONE-236B Friendli render structure", () => {
  it.each([
    { id: "no-system-thinking-on", enableThinking: true, system: undefined },
    { id: "no-system-thinking-off", enableThinking: false, system: undefined },
    {
      id: "system-thinking-on",
      enableThinking: true,
      system: "SYSTEM_SENTINEL",
    },
    {
      id: "system-thinking-off",
      enableThinking: false,
      system: "SYSTEM_SENTINEL",
    },
  ])(
    "$id preserves the native declaration before the Hermes guide",
    async (scenario) => {
      // Given
      const prompt: LanguageModelV4Prompt = [
        ...(scenario.system === undefined
          ? []
          : [{ role: "system" as const, content: scenario.system }]),
        {
          role: "user",
          content: [{ type: "text", text: "Run the probe." }],
        },
      ];

      // When
      const nativeBody = await captureProviderBody({ prompt });
      const middlewareBody = await captureProviderBody({
        middleware: kExaone236BToolMiddleware,
        prompt,
      });
      const native = await renderFriendli({
        body: nativeBody,
        enableThinking: scenario.enableThinking,
      });
      const middleware = await renderFriendli({
        body: middlewareBody,
        enableThinking: scenario.enableThinking,
      });

      // Then
      const turnBoundary = "<|endofturn|>\n";
      const nativeDeclarationEnd =
        native.indexOf(turnBoundary) + turnBoundary.length;
      const middlewareGuideStart = middleware.indexOf("<|system|>");
      expect(nativeDeclarationEnd).toBeGreaterThan(turnBoundary.length - 1);
      expect(middlewareGuideStart).toBe(nativeDeclarationEnd);
      expect(middleware.slice(0, middlewareGuideStart)).toBe(
        native.slice(0, nativeDeclarationEnd)
      );
      expect(middleware).toContain(
        "# Tool Call Format\nWhen calling a tool, output exactly one JSON object inside <tool_call> tags:"
      );
      expect(middleware).toContain(
        '<tool_call>{"name":"example_tool_name","arguments":{"arg1":"value1"}}</tool_call>'
      );
      expect(middleware.indexOf("<|system|>")).toBeLessThan(
        middleware.indexOf("<|user|>")
      );
    }
  );
});
