import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { glm5ToolMiddleware } from "../../preconfigured-middleware";

describe("glm5ToolMiddleware wire transport", () => {
  it("injects declarations while preserving provider-native tool history", async () => {
    let capturedBody: unknown;
    const provider = createOpenAICompatible({
      apiKey: "test-key",
      baseURL: "https://capture.invalid/v1",
      fetch: (_input, init) => {
        if (typeof init?.body !== "string") {
          throw new TypeError("Expected a JSON request body");
        }
        capturedBody = JSON.parse(init.body);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "response-1",
              created: 0,
              model: "probe-model",
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
      name: "glm5-capture",
    });
    const model = wrapLanguageModel({
      middleware: glm5ToolMiddleware,
      model: provider.chatModel("probe-model"),
    });

    await model.doGenerate({
      prompt: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "weather",
              input: { city: "Seoul" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "weather",
              output: { type: "json", value: { temperature: 21 } },
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "text", text: "Continue." }],
        },
      ],
      tools: [
        {
          type: "function",
          name: "weather",
          inputSchema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
    });

    expect(capturedBody).not.toHaveProperty("tools");
    expect(capturedBody).not.toHaveProperty("tool_choice");
    expect(capturedBody).toMatchObject({
      messages: [
        {
          role: "system",
          content: expect.stringContaining("# Tools"),
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              function: {
                name: "weather",
                arguments: '{"city":"Seoul"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call-1",
          content: '{"temperature":21}',
        },
        { role: "user", content: "Continue." },
      ],
    });
  });
});
