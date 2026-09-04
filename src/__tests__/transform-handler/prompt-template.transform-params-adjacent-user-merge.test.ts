import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { formatToolResponseAsHermes } from "../../core/prompts/hermes-prompt";
import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { createToolMiddleware } from "../../tool-call-middleware";
import { requireTransformParams } from "../test-helpers";

const model = new MockLanguageModelV4();
const toolResponsePattern = /<tool_response>/g;

function hermesTransform(toolResponses = false) {
  const middleware = createToolMiddleware({
    protocol: hermesProtocol,
    placement: "first",
    toolSystemPromptTemplate: (tools) => `T:${tools}`,
    ...(toolResponses
      ? { toolResponsePromptTemplate: formatToolResponseAsHermes }
      : {}),
  });
  return requireTransformParams(middleware.transformParams);
}

describe("transformParams merges adjacent user messages", () => {
  it("merges two consecutive user messages into one with newline", async () => {
    const out = await hermesTransform()({
      type: "generate",
      model,
      params: {
        prompt: [
          { role: "user", content: [{ type: "text", text: "first" }] },
          { role: "user", content: [{ type: "text", text: "second" }] },
        ],
        tools: [],
      },
    });

    // After inserting system, the merged user should be at index 1
    const user = out.prompt.find((message) => message.role === "user");
    if (!user) {
      throw new Error("user message not found");
    }
    const text = user.content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("");
    expect(text).toBe("first\nsecond");
  });

  it("condenses multiple tool_response messages into single user text content", async () => {
    const out = await hermesTransform(true)({
      type: "generate",
      model,
      params: {
        prompt: [
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolName: "get_weather",
                toolCallId: "a",
                output: {
                  type: "json",
                  value: {
                    city: "New York",
                    temperature: 25,
                    condition: "sunny",
                  },
                },
              },
              {
                type: "tool-result",
                toolName: "get_weather",
                toolCallId: "b",
                output: {
                  type: "json",
                  value: {
                    city: "Los Angeles",
                    temperature: 58,
                    condition: "sunny",
                  },
                },
              },
            ],
          },
        ],
        tools: [
          {
            type: "function",
            name: "get_weather",
            description: "",
            inputSchema: { type: "object" },
          },
        ],
      },
    });

    const userMsgs = out.prompt.filter((message) => message.role === "user");
    expect(userMsgs).toHaveLength(1);
    const [user] = userMsgs;
    if (user?.role !== "user") {
      throw new Error("user message not found");
    }
    // Single text content only
    expect(
      user.content.filter((content) => content.type === "text")
    ).toHaveLength(1);
    const [textPart] = user.content;
    if (textPart?.type !== "text") {
      throw new Error("text content not found");
    }
    const { text } = textPart;
    // Contains two tool_response blocks
    expect((text.match(toolResponsePattern) || []).length).toBe(2);
    expect(user.content.length).toBe(1);
  });
});
