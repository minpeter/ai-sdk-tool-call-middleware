import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { formatToolResponseAsHermes as renderHermesToolResponse } from "../../core/prompts/hermes-prompt";
import { hermesProtocol as createHermesProtocol } from "../../core/protocols/hermes-protocol";
import type { ToolInputSchema } from "../../schema/tool-input-schema";
import { createToolMiddleware } from "../../tool-call-middleware";
import { requireTransformParams } from "../test-helpers";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

const model: LanguageModelV4 = {
  modelId: "test",
  provider: "test",
  supportedUrls: {},
  specificationVersion: "v4",
  doStream() {
    throw new Error("unused");
  },
  doGenerate() {
    throw new Error("unused");
  },
};

const REGEX_TOOL_CALL_TAG = /<tool_call>/;
const REGEX_TOOL_RESPONSE_TAG = /<tool_response>/;

describe("transformParams convertToolPrompt mapping and merge", () => {
  const mw = createToolMiddleware({
    protocol: createHermesProtocol,
    placement: "first",
    toolSystemPromptTemplate: (t) => `TOOLS:${t}`,
    toolResponsePromptTemplate: renderHermesToolResponse,
  });

  it("converts assistant tool-call and tool role messages, merges adjacent user texts, and preserves providerOptions", async () => {
    const params: LanguageModelV4CallOptions = {
      prompt: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "tc1",
              toolName: "t1",
              input: "{}",
            },
            { type: "text", text: "aside" },
            { type: "custom", kind: "test.part" },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolName: "t1",
              toolCallId: "tc1",
              output: { type: "json", value: { ok: true } },
            },
            {
              type: "tool-result",
              toolName: "t1",
              toolCallId: "tc1",
              output: { type: "json", value: { alt: 1 } },
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "t1",
          description: "desc",
          inputSchema: { type: "object" } satisfies ToolInputSchema,
        },
      ],
      providerOptions: { toolCallMiddleware: { existing: true } },
    };

    const transformParams = requireTransformParams(mw.transformParams);
    const out = await transformParams({ type: "generate", model, params });
    expect(out.prompt[0].role).toBe("system");
    // Assistant remains assistant with formatted tool call text
    const assistantMsg = out.prompt.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeTruthy();
    if (!assistantMsg) {
      throw new Error("assistant message not found");
    }
    const assistantText = assistantMsg.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("");
    expect(assistantText).toMatch(REGEX_TOOL_CALL_TAG);

    // Tool role becomes user text; original user remains user; they are not adjacent so not merged
    const userMsgs = out.prompt.filter((m) => m.role === "user");
    expect(userMsgs.length).toBe(2);
    const userCombined = userMsgs
      .map((u) =>
        u.content.map((c) => (c.type === "text" ? c.text : "")).join("")
      )
      .join("\n");
    expect(userCombined).toContain("hello");
    expect(userCombined).toMatch(REGEX_TOOL_RESPONSE_TAG);

    // tools cleared; originalTools propagated into providerOptions
    expect(out.tools).toEqual([]);
    const middlewareOptions = out.providerOptions?.toolCallMiddleware;
    expect(middlewareOptions).toMatchObject({ existing: true });
    if (!middlewareOptions) {
      throw new Error("tool middleware options not found");
    }
    expect(middlewareOptions.originalTools).toEqual([
      {
        name: "t1",
        inputSchema: JSON.stringify({ type: "object" }),
      },
    ]);
  });

  it("condenses multiple text parts in a single user message into one", async () => {
    const params: LanguageModelV4CallOptions = {
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "line1" },
            { type: "text", text: "line2" },
          ],
        },
      ],
      tools: [],
    };

    const transformParams = requireTransformParams(mw.transformParams);
    const out = await transformParams({ type: "generate", model, params });
    const userMsgs = out.prompt.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    const [onlyUser] = userMsgs;
    if (!onlyUser) {
      throw new Error("user message not found");
    }
    const onlyText = onlyUser.content.every((c) => c.type === "text");
    expect(onlyText).toBe(true);
    expect(onlyUser.content).toHaveLength(1);
    const [firstPart] = onlyUser.content;
    if (firstPart?.type !== "text") {
      throw new Error("text part not found");
    }
    expect(firstPart.text).toBe("line1\nline2");
  });

  it("preserves assistant reasoning parts and formats tool-call", async () => {
    const params: LanguageModelV4CallOptions = {
      prompt: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "tc1",
              toolName: "t1",
              input: "{}",
            },
            {
              type: "reasoning",
              text: "thinking...",
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "t1",
          description: "desc",
          inputSchema: { type: "object" } satisfies ToolInputSchema,
        },
      ],
    };

    const transformParams = requireTransformParams(mw.transformParams);
    const out = await transformParams({ type: "generate", model, params });
    const assistant = out.prompt.find((m) => m.role === "assistant");
    if (!assistant) {
      throw new Error("assistant message not found");
    }
    // Should contain both formatted tool_call text and original reasoning block
    const hasReasoning = assistant.content.some((c) => c.type === "reasoning");
    expect(hasReasoning).toBe(true);
    const assistantText = assistant.content
      .filter(
        (c): c is Extract<LanguageModelV4Content, { type: "text" }> =>
          c.type === "text"
      )
      .map((c) => c.text)
      .join("\n");
    expect(assistantText).toMatch(REGEX_TOOL_CALL_TAG);
    // Ensure the reasoning's inner text remains
    const reasoning = assistant.content.find((c) => c.type === "reasoning");
    if (reasoning?.type !== "reasoning") {
      throw new Error("reasoning part not found");
    }
    expect(reasoning.text).toContain("thinking...");
  });
});
