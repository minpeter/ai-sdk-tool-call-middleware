import { describe, expect, it, vi } from "vitest";
import { formatToolResponseAsHermes } from "../../core/prompts/hermes-prompt";
import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { createToolMiddleware } from "../../tool-call-middleware";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

// Regex constants for performance
const _REGEX_ACCESS_TO_FUNCTIONS = /You have access to functions/;
const _REGEX_TOOL_CALL_FENCE = /```tool_call/;
const _REGEX_TOOL_RESPONSE_FENCE = /```tool_response/;
const _REGEX_GET_WEATHER = /get_weather/;
const _REGEX_FUNCTION_CALLING_MODEL = /You are a function calling AI model/;
const _REGEX_MAY_CALL_FUNCTIONS = /You may call one or more functions/;
const _REGEX_TOOLS_TAG = /<tools>/;
const _REGEX_NONE = /none/;
const _REGEX_NOT_FOUND = /not found/;
const _REGEX_PROVIDER_DEFINED = /Provider-defined tools/;
const _REGEX_REQUIRED_NO_TOOLS =
  /Tool choice type 'required' is set, but no tools are provided/;
const _REGEX_REQUIRED_NO_FUNCTION_TOOLS = /no function tools are provided/;
const REGEX_TOOL_CALL_TAG = /<tool_call>/;
const REGEX_TOOL_RESPONSE_TAG = /<tool_response>/;
const _REGEX_GET_WEATHER_TAG = /<get_weather>/;
const _REGEX_TOOL_CALL_WORD = /tool_call/;

describe("transformParams convertToolPrompt mapping and merge", () => {
  const mw = createToolMiddleware({
    protocol: hermesProtocol,
    placement: "first",
    toolSystemPromptTemplate: (t) => `TOOLS:${t}`,
    toolResponsePromptTemplate: formatToolResponseAsHermes,
  });

  it("converts assistant tool-call and tool role messages, merges adjacent user texts, and preserves providerOptions", async () => {
    const params = {
      prompt: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "hello" }],
        },
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call",
              toolCallId: "tc1",
              toolName: "t1",
              input: "{}",
            },
            { type: "text", text: "aside" },
            { foo: "bar" } as any,
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result",
              toolName: "t1",
              toolCallId: "tc1",
              output: { ok: true },
            },
            { toolName: "t1", toolCallId: "tc1", output: { alt: 1 } } as any,
          ],
        },
      ],
      tools: [
        {
          type: "function" as const,
          name: "t1",
          description: "desc",
          inputSchema: { type: "object" },
        },
      ],
      providerOptions: { toolCallMiddleware: { existing: true } },
    };

    const transformParams = mw.transformParams;
    if (!transformParams) {
      throw new Error("transformParams is undefined");
    }
    const out = await transformParams({ params } as any);
    expect(out.prompt[0].role).toBe("system");
    // Assistant remains assistant with formatted tool call text
    const assistantMsg = out.prompt.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeTruthy();
    if (!assistantMsg) {
      throw new Error("assistant message not found");
    }
    const assistantText = assistantMsg.content
      .map((c) => (c.type === "text" ? (c as any).text : ""))
      .join("");
    expect(assistantText).toMatch(REGEX_TOOL_CALL_TAG);

    // Tool role becomes user text; original user remains user; they are not adjacent so not merged
    const userMsgs = out.prompt.filter((m) => m.role === "user");
    expect(userMsgs.length).toBe(2);
    const userCombined = userMsgs
      .map((u) =>
        u.content
          .map((c) => (c.type === "text" ? (c as any).text : ""))
          .join("")
      )
      .join("\n");
    expect(userCombined).toContain("hello");
    expect(userCombined).toMatch(REGEX_TOOL_RESPONSE_TAG);

    // tools cleared; originalTools propagated into providerOptions
    expect(out.tools).toEqual([]);
    const originalTools = (out.providerOptions as any).toolCallMiddleware
      .originalTools;
    expect(originalTools).toEqual([
      {
        name: "t1",
        inputSchema: JSON.stringify({ type: "object" }),
      },
    ]);
    // existing provider option preserved
    expect((out.providerOptions as any).toolCallMiddleware.existing).toBe(true);
  });

  it("condenses multiple text parts in a single user message into one", async () => {
    const params = {
      prompt: [
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: "line1" },
            { type: "text" as const, text: "line2" },
          ],
        },
      ],
      tools: [],
    };

    const transformParams = mw.transformParams;
    if (!transformParams) {
      throw new Error("transformParams is undefined");
    }
    const out = await transformParams({ params } as any);
    const userMsgs = out.prompt.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    const onlyText = userMsgs[0].content.every((c: any) => c.type === "text");
    expect(onlyText).toBe(true);
    expect(userMsgs[0].content).toHaveLength(1);
    expect((userMsgs[0].content[0] as any).text).toBe("line1\nline2");
  });

  it("preserves assistant reasoning parts and formats tool-call", async () => {
    const params = {
      prompt: [
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "tc1",
              toolName: "t1",
              input: "{}",
            },
            {
              type: "reasoning" as const,
              content: [{ type: "text", text: "thinking..." }],
            } as any,
          ],
        },
      ],
      tools: [
        {
          type: "function" as const,
          name: "t1",
          description: "desc",
          inputSchema: { type: "object" },
        },
      ],
    };

    const transformParams = mw.transformParams;
    if (!transformParams) {
      throw new Error("transformParams is undefined");
    }
    const out = await transformParams({ params } as any);
    const assistant = out.prompt.find((m) => m.role === "assistant");
    if (!assistant) {
      throw new Error("assistant message not found");
    }
    const assistantAny = assistant as any;
    // Should contain both formatted tool_call text and original reasoning block
    const hasReasoning = assistantAny.content.some(
      (c: any) => c.type === "reasoning"
    );
    expect(hasReasoning).toBe(true);
    const assistantText = assistantAny.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
    expect(assistantText).toMatch(REGEX_TOOL_CALL_TAG);
    // Ensure the reasoning's inner text remains
    const reasoning = assistantAny.content.find(
      (c: any) => c.type === "reasoning"
    );
    expect(
      (reasoning as any).content?.map((p: any) => p.text).join("")
    ).toContain("thinking...");
  });
});
