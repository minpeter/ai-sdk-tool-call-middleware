import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { glm5SystemPromptTemplate } from "../../core/prompts/glm5-prompt";
import { glm5Protocol } from "../../core/protocols/glm5-protocol";
import { glm5ToolMiddleware } from "../../preconfigured-middleware";
import { createToolMiddleware } from "../../tool-call-middleware";
import { requireTransformParams } from "../test-helpers";

const tools = [
  {
    type: "function" as const,
    name: "get_weather",
    description: "Weather lookup",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string" },
        days: { type: "integer" },
        strict: { type: "boolean" },
      },
      required: ["city"],
    },
  },
];

describe("GLM-5.2 chat-template alignment", () => {
  it("prepends a standalone tools system turn and preserves provider-native tool history", async () => {
    const originalPrompt: LanguageModelV4Prompt = [
      {
        role: "system",
        content: "Follow policy.",
        providerOptions: { test: { marker: "existing-system" } },
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Weather for " },
          { type: "text", text: "Seoul?" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will check." },
          {
            type: "tool-call",
            toolCallId: "tc-weather",
            toolName: "get_weather",
            input: { city: "Seoul", days: 3, strict: false },
            providerOptions: { test: { marker: "native-tool-call" } },
          },
        ],
        providerOptions: { test: { marker: "assistant-message" } },
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-weather",
            toolName: "get_weather",
            output: {
              type: "json",
              value: { temperature: 21 },
            },
            providerOptions: { test: { marker: "native-tool-result" } },
          },
        ],
        providerOptions: { test: { marker: "tool-message" } },
      },
    ];

    const middleware = createToolMiddleware({
      historyMode: "provider-native",
      placement: "standalone-first",
      protocol: glm5Protocol,
      toolSystemPromptTemplate: glm5SystemPromptTemplate,
    });
    const transformParams = requireTransformParams(middleware.transformParams);
    const result = await transformParams({
      params: {
        prompt: originalPrompt,
        tools,
      },
    } as never);

    expect(result.prompt).toHaveLength(originalPrompt.length + 1);
    expect(result.prompt[0]).toMatchObject({
      role: "system",
    });
    expect(String(result.prompt[0].content)).toContain("# Tools");
    expect(String(result.prompt[0].content)).toContain('"name":"get_weather"');
    expect(String(result.prompt[0].content)).toContain(
      "<tool_call>{function-name}<arg_key>"
    );

    // GLM's official template emits the tools system turn before messages.
    // Existing messages must remain separate and in their original native form.
    expect(result.prompt.slice(1)).toEqual(originalPrompt);
    for (const [index, message] of originalPrompt.entries()) {
      expect(result.prompt[index + 1]).toBe(message);
    }
    expect(result.prompt[1]).toEqual(originalPrompt[0]);
    expect(result.prompt[3]?.role).toBe("assistant");
    expect(result.prompt[3]?.content[1]).toMatchObject({
      type: "tool-call",
      input: { city: "Seoul", days: 3, strict: false },
    });
    expect(result.prompt[4]).toEqual(originalPrompt[3]);
    expect(result.tools).toEqual([]);
  });

  it("retains provider-native history when toolChoice is none", async () => {
    const nativeHistory: LanguageModelV4Prompt = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tc-1",
            toolName: "ping",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-1",
            toolName: "ping",
            output: { type: "text", value: "pong" },
          },
        ],
      },
    ];
    const middleware = createToolMiddleware({
      historyMode: "provider-native",
      placement: "standalone-first",
      protocol: glm5Protocol,
      toolSystemPromptTemplate: glm5SystemPromptTemplate,
    });
    const transformParams = requireTransformParams(middleware.transformParams);

    const result = await transformParams({
      params: {
        prompt: nativeHistory,
        toolChoice: { type: "none" },
        tools: [
          {
            type: "function",
            name: "ping",
            inputSchema: { type: "object" },
          },
        ],
      },
    } as never);

    expect(result.prompt).toEqual(nativeHistory);
    expect(result.prompt[0]).toBe(nativeHistory[0]);
    expect(result.prompt[1]).toBe(nativeHistory[1]);
    expect(result.tools).toEqual([]);
    expect(result.toolChoice).toBeUndefined();
  });

  it.each([
    {
      label: "required",
      toolChoice: { type: "required" as const },
    },
    {
      label: "fixed tool",
      toolChoice: { type: "tool" as const, toolName: "get_weather" },
    },
  ])(
    "uses only the JSON response format for $label without conflicting GLM XML instructions",
    async ({ toolChoice }) => {
      const nativeHistory: LanguageModelV4Prompt = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "tc-1",
              toolName: "get_weather",
              input: { city: "Seoul" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tc-1",
              toolName: "get_weather",
              output: { type: "text", value: "sunny" },
            },
          ],
        },
      ];
      const transformParams = requireTransformParams(
        glm5ToolMiddleware.transformParams
      );

      const result = await transformParams({
        params: {
          prompt: nativeHistory,
          toolChoice,
          tools,
        },
      } as never);

      expect(result.prompt).toEqual(nativeHistory);
      expect(result.prompt[0]).toBe(nativeHistory[0]);
      expect(result.prompt[1]).toBe(nativeHistory[1]);
      expect(result.tools).toEqual([]);
      expect(result.toolChoice).toBeUndefined();
      expect(result.responseFormat).toMatchObject({ type: "json" });
      expect(
        (result.providerOptions as Record<string, any>).toolCallMiddleware
          .toolChoice
      ).toEqual(toolChoice);
      expect(
        result.prompt.some(
          (message) =>
            message.role === "system" &&
            String(message.content).includes("# Tools")
        )
      ).toBe(false);
    }
  );

  it("keeps the existing forced-choice prompt behavior for custom middleware by default", async () => {
    const middleware = createToolMiddleware({
      historyMode: "provider-native",
      placement: "standalone-first",
      protocol: glm5Protocol,
      toolSystemPromptTemplate: glm5SystemPromptTemplate,
    });
    const transformParams = requireTransformParams(middleware.transformParams);

    const result = await transformParams({
      params: {
        prompt: [],
        toolChoice: { type: "required" },
        tools,
      },
    } as never);

    expect(result.prompt).toHaveLength(1);
    expect(result.prompt[0]).toMatchObject({ role: "system" });
    expect(String(result.prompt[0]?.content)).toContain("# Tools");
    expect(result.responseFormat).toMatchObject({ type: "json" });
  });
});
