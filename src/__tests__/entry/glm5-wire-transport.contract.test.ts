import {
  isJSONObject,
  isJSONValue,
  type JSONArray,
  type JSONObject,
  type JSONValue,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { glm5ToolMiddleware } from "../../preconfigured-middleware";
import { captureProviderBody } from "./provider-capture.shared";

type Glm5RequestBody = JSONObject & {
  readonly messages: JSONArray;
};

function isGlm5RequestBody(value: JSONValue): value is Glm5RequestBody {
  return isJSONObject(value) && Array.isArray(value.messages);
}

function parseGlm5RequestBody(source: string): Glm5RequestBody {
  const value = JSON.parse(source);
  if (!(isJSONValue(value) && isGlm5RequestBody(value))) {
    throw new TypeError("Expected a GLM-5 request body");
  }
  return value;
}

describe("glm5ToolMiddleware wire transport", () => {
  it("injects declarations while preserving provider-native tool history", async () => {
    const capturedBody = await captureProviderBody({
      name: "glm5-capture",
      apiKey: "test-key",
      baseURL: "https://capture.invalid/v1",
      modelId: "probe-model",
      middleware: glm5ToolMiddleware,
      parseBody: parseGlm5RequestBody,
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
