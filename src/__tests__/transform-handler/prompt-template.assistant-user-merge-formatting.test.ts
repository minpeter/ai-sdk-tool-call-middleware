import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import {
  hermesToolMiddleware,
  morphXmlToolMiddleware,
} from "../../preconfigured-middleware";
import { requireTransformParams } from "../test-helpers";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

const model = new MockLanguageModelV4();
const toolResponsePattern = /<tool_response>/;
const formattingCases = [
  {
    name: "hermes: formats assistant tool-call (object input) and tool result into user text",
    middleware: hermesToolMiddleware,
    assistantPattern: /<tool_call>/,
  },
  {
    name: "xml: formats assistant tool-call (object input) and tool result into user text",
    middleware: morphXmlToolMiddleware,
    assistantPattern: /<get_weather>/,
  },
];

describe("non-stream assistant->user merge formatting with object input", () => {
  for (const testCase of formattingCases) {
    it(testCase.name, async () => {
      const transformParams = requireTransformParams(
        testCase.middleware.transformParams
      );
      const out = await transformParams({
        type: "generate",
        model,
        params: {
          prompt: [
            { role: "user", content: [{ type: "text", text: "q" }] },
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "tc1",
                  toolName: "get_weather",
                  input: JSON.stringify({ city: "Seoul" }),
                },
              ],
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolName: "get_weather",
                  toolCallId: "tc1",
                  output: { type: "json", value: { ok: true } },
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

      const assistantMsg = out.prompt.find(
        (message) => message.role === "assistant"
      );
      if (!assistantMsg) {
        throw new Error("assistant message not found");
      }
      const assistantText = assistantMsg.content
        .map((content) => (content.type === "text" ? content.text : ""))
        .join("");
      expect(assistantText).toMatch(testCase.assistantPattern);

      const userCombined = out.prompt
        .filter((message) => message.role === "user")
        .map((message) =>
          message.content
            .map((content) => (content.type === "text" ? content.text : ""))
            .join("")
        )
        .join("\n");
      expect(userCombined).toMatch(toolResponsePattern);
    });
  }
});
