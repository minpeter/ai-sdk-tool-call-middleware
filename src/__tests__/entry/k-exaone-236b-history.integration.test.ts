import {
  isJSONObject,
  isJSONValue,
  type JSONArray,
  type JSONObject,
  type JSONValue,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { kExaone236BToolMiddleware } from "../../preconfigured-middleware";
import { captureProviderBody } from "./provider-capture.shared";

type KExaoneRequestBody = JSONObject & {
  readonly messages: JSONArray;
};

function isKExaoneRequestBody(value: JSONValue): value is KExaoneRequestBody {
  return isJSONObject(value) && Array.isArray(value.messages);
}

function parseKExaoneRequestBody(source: string): KExaoneRequestBody {
  const value = JSON.parse(source);
  if (!(isJSONValue(value) && isKExaoneRequestBody(value))) {
    throw new TypeError("Expected a K-EXAONE request body");
  }
  return value;
}

describe("kExaone236BToolMiddleware history branches", () => {
  it("preserves null assistant text and error-text tool results without reasoning", async () => {
    // Given
    const toolCallId = "call-1";
    const toolName = "edge_probe";

    // When
    const capturedBody = await captureProviderBody({
      name: "friendli-capture",
      apiKey: "test-key",
      baseURL: "https://capture.invalid/v1",
      modelId: "probe-model",
      middleware: kExaone236BToolMiddleware,
      parseBody: parseKExaoneRequestBody,
      prompt: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId,
              toolName,
              input: { value: 1 },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId,
              toolName,
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
          name: toolName,
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
