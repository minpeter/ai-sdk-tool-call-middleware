import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { kExaone236BToolMiddleware } from "../../preconfigured-middleware";

describe("kExaone236BToolMiddleware history branches", () => {
  it("preserves null assistant text and error-text tool results without reasoning", async () => {
    // Given
    let capturedBody: unknown;
    const provider = createOpenAICompatible({
      name: "friendli-capture",
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
    });
    const model = wrapLanguageModel({
      model: provider.chatModel("probe-model"),
      middleware: kExaone236BToolMiddleware,
    });

    // When
    await model.doGenerate({
      prompt: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "edge_probe",
              input: { value: 1 },
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
              output: { type: "error-text", value: "FAILED" },
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "text", text: "Recover." }],
        },
      ],
      tools: [
        {
          type: "function",
          name: "edge_probe",
          inputSchema: {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
          },
        },
      ],
    });

    // Then
    expect(capturedBody).toMatchObject({
      messages: [
        { role: "tool_declare" },
        {
          role: "system",
          content: expect.stringContaining("# Tool Call Format"),
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              function: {
                name: "edge_probe",
                arguments: '{"value":1}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call-1",
          content: "FAILED",
        },
        { role: "user", content: "Recover." },
      ],
    });
    expect(capturedBody).not.toHaveProperty("messages[2].reasoning_content");
  });
});
