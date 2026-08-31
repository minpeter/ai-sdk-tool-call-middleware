import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, stepCountIs, tool, wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { kExaone236BToolMiddleware } from "../../preconfigured-middleware";

const firstStepResponse = {
  id: "response-1",
  created: 0,
  model: "probe-model",
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: `<tool_call>{"name":"inspect_payload","arguments":{"label":"서울","nested":{"order":["alpha",{"count":2}]}}}</tool_call>
<tool_call>{"name":"record_payload","arguments":{"status":"ok"}}</tool_call>`,
        reasoning_content: "reasoning sentinel",
      },
    },
  ],
  usage: {
    prompt_tokens: 1,
    completion_tokens: 1,
    total_tokens: 2,
  },
};

const finalStepResponse = {
  id: "response-2",
  created: 0,
  model: "probe-model",
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: "trajectory complete" },
    },
  ],
  usage: {
    prompt_tokens: 1,
    completion_tokens: 1,
    total_tokens: 2,
  },
};

describe("kExaone236BToolMiddleware multistep replay", () => {
  it("replays parsed calls, reasoning, and consecutive results natively", async () => {
    // Given
    const requestBodies: unknown[] = [];
    const provider = createOpenAICompatible({
      name: "friendli-capture",
      apiKey: "test-key",
      baseURL: "https://capture.invalid/v1",
      fetch: (_input, init) => {
        if (typeof init?.body !== "string") {
          throw new TypeError("Expected a JSON request body");
        }
        requestBodies.push(JSON.parse(init.body));
        const responseBody =
          requestBodies.length === 1 ? firstStepResponse : finalStepResponse;
        return Promise.resolve(
          new Response(JSON.stringify(responseBody), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        );
      },
    });
    const model = wrapLanguageModel({
      model: provider.chatModel("probe-model"),
      middleware: kExaone236BToolMiddleware,
    });

    // When
    const result = await generateText({
      model,
      prompt: "Run both payload tools.",
      stopWhen: stepCountIs(2),
      tools: {
        inspect_payload: tool({
          description: "Inspect a nested payload.",
          inputSchema: z.object({
            label: z.string(),
            nested: z.object({
              order: z.array(
                z.union([z.string(), z.object({ count: z.number() })])
              ),
            }),
          }),
          execute: ({ label, nested }) => ({
            kind: "inspection",
            label,
            nested,
          }),
        }),
        record_payload: tool({
          description: "Record a payload status.",
          inputSchema: z.object({ status: z.string() }),
          execute: ({ status }) => `recorded:${status}`,
        }),
      },
    });

    // Then
    expect(result.text).toBe("trajectory complete");
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1]).toMatchObject({
      messages: [
        { role: "tool_declare" },
        {
          role: "system",
          content: expect.stringContaining("# Tool Call Format"),
        },
        { role: "user", content: "Run both payload tools." },
        {
          role: "assistant",
          content: null,
          reasoning_content: "reasoning sentinel",
          tool_calls: [
            {
              type: "function",
              function: {
                name: "inspect_payload",
                arguments:
                  '{"label":"서울","nested":{"order":["alpha",{"count":2}]}}',
              },
            },
            {
              type: "function",
              function: {
                name: "record_payload",
                arguments: '{"status":"ok"}',
              },
            },
          ],
        },
        {
          role: "tool",
          content:
            '{"kind":"inspection","label":"서울","nested":{"order":["alpha",{"count":2}]}}',
        },
        {
          role: "tool",
          content: "recorded:ok",
        },
      ],
    });
    expect(requestBodies[1]).not.toHaveProperty("tools");
  });
});
