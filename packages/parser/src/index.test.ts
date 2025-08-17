import { describe, it, expect } from "vitest";
import {
  gemmaToolMiddleware,
  hermesToolMiddleware,
  createToolMiddleware,
} from "./index";
import type {
  LanguageModelV2Message,
  LanguageModelV2FunctionTool,
  LanguageModelV2Content,
} from "@ai-sdk/provider";

describe("index exports", () => {
  describe("gemmaToolMiddleware", () => {
    it("should be defined with correct properties", () => {
      expect(gemmaToolMiddleware).toBeDefined();
      expect(gemmaToolMiddleware.middlewareVersion).toBe("v2");
      expect(gemmaToolMiddleware.wrapGenerate).toBeDefined();
      expect(gemmaToolMiddleware.wrapStream).toBeDefined();
      expect(gemmaToolMiddleware.transformParams).toBeDefined();
    });

    it("should use markdown code blocks for tool calls", async () => {
      const params: {
        prompt: LanguageModelV2Message[];
        tools: LanguageModelV2FunctionTool[];
      } = {
        prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
        tools: [
          {
            type: "function",
            name: "getTool",
            description: "Gets a tool",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string" },
              },
            },
          },
        ],
      };

      const result = await gemmaToolMiddleware.transformParams!({
        params,
      } as any);

      // Check that the prompt has been transformed
      expect(result.prompt).toBeDefined();
      expect(result.tools).toEqual([]);

      // Verify the system prompt contains gemma-specific formatting
      const systemMessage = result.prompt.find(
        (msg: LanguageModelV2Message) => msg.role === "system"
      );
      if (systemMessage && typeof systemMessage.content === "string") {
        expect(systemMessage.content).toContain("```tool_call");
        expect(systemMessage.content).toContain(
          "{'name': <function-name>, 'arguments': <args-dict>}"
        );
      }
    });
  });

  describe("hermesToolMiddleware", () => {
    it("should be defined with correct properties", () => {
      expect(hermesToolMiddleware).toBeDefined();
      expect(hermesToolMiddleware.middlewareVersion).toBe("v2");
      expect(hermesToolMiddleware.wrapGenerate).toBeDefined();
      expect(hermesToolMiddleware.wrapStream).toBeDefined();
      expect(hermesToolMiddleware.transformParams).toBeDefined();
    });

    it("should use XML tags for tool calls", async () => {
      const params: {
        prompt: LanguageModelV2Message[];
        tools: LanguageModelV2FunctionTool[];
      } = {
        prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
        tools: [
          {
            type: "function",
            name: "getTool",
            description: "Gets a tool",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string" },
              },
            },
          },
        ],
      };

      const result = await hermesToolMiddleware.transformParams!({
        params,
      } as any);

      // Check that the prompt has been transformed
      expect(result.prompt).toBeDefined();
      expect(result.tools).toEqual([]);

      // Verify the system prompt contains hermes-specific formatting
      const systemMessage = result.prompt.find(
        (msg: LanguageModelV2Message) => msg.role === "system"
      );
      if (systemMessage && typeof systemMessage.content === "string") {
        expect(systemMessage.content).toContain("<tool_call>");
        expect(systemMessage.content).toContain("</tool_call>");
        expect(systemMessage.content).toContain("<tools>");
        expect(systemMessage.content).toContain("</tools>");
      }
    });
  });

  describe("createToolMiddleware export", () => {
    it("should be exported and callable", () => {
      expect(createToolMiddleware).toBeDefined();
      expect(typeof createToolMiddleware).toBe("function");
    });

    it("should create custom middleware", () => {
      const customMiddleware = createToolMiddleware({
        toolCallTag: "[[TOOL",
        toolCallEndTag: "TOOL]]",
        toolResponseTag: "[[RESPONSE",
        toolResponseEndTag: "RESPONSE]]",
        toolSystemPromptTemplate: (tools: string) =>
          `Custom template: ${tools}`,
      });

      expect(customMiddleware).toBeDefined();
      expect(customMiddleware.middlewareVersion).toBe("v2");
      expect(customMiddleware.wrapGenerate).toBeDefined();
      expect(customMiddleware.wrapStream).toBeDefined();
      expect(customMiddleware.transformParams).toBeDefined();
    });
  });

  describe("middleware configurations", () => {
    it("gemma should use two backticks for end tag", async () => {
      // This is a specific quirk of gemma - it often outputs only two backticks
      // The configuration accounts for this
      const mockDoGenerate = () =>
        Promise.resolve({
          content: [
            {
              type: "text" as const,
              text: '```tool_call\n{"name": "test", "arguments": {}}\n``',
            },
          ] as LanguageModelV2Content[],
        });

      const result = await gemmaToolMiddleware.wrapGenerate!({
        doGenerate: mockDoGenerate,
        params: { prompt: [] },
      } as any);

      const toolCalls = result.content.filter(
        (c): c is Extract<LanguageModelV2Content, { type: "tool-call" }> =>
          c.type === "tool-call"
      );
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].toolName).toBe("test");
    });

    it("hermes should parse XML-style tool calls", async () => {
      const mockDoGenerate = () =>
        Promise.resolve({
          content: [
            {
              type: "text" as const,
              text: '<tool_call>\n{"arguments": {"arg": "value"}, "name": "testTool"}\n</tool_call>',
            },
          ] as LanguageModelV2Content[],
        });

      const result = await hermesToolMiddleware.wrapGenerate!({
        doGenerate: mockDoGenerate,
        params: { prompt: [] },
      } as any);

      const toolCalls = result.content.filter(
        (c): c is Extract<LanguageModelV2Content, { type: "tool-call" }> =>
          c.type === "tool-call"
      );
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].toolName).toBe("testTool");
      expect(JSON.parse(toolCalls[0].input)).toEqual({ arg: "value" });
    });
  });

  describe("error handling", () => {
    it("gemma should handle malformed tool calls", async () => {
      const mockDoGenerate = () =>
        Promise.resolve({
          content: [
            {
              type: "text" as const,
              text: "```tool_call\ninvalid json\n```",
            },
          ] as LanguageModelV2Content[],
        });

      const result = await gemmaToolMiddleware.wrapGenerate!({
        doGenerate: mockDoGenerate,
        params: { prompt: [] },
      } as any);

      // Should keep the original text when parsing fails
      expect(result.content[0].type).toBe("text");
    });

    it("hermes should handle malformed tool calls", async () => {
      const mockDoGenerate = () =>
        Promise.resolve({
          content: [
            {
              type: "text" as const,
              text: "<tool_call>not valid json</tool_call>",
            },
          ] as LanguageModelV2Content[],
          finishReason: "stop" as const,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          warnings: [],
        });

      const result = await hermesToolMiddleware.wrapGenerate!({
        doGenerate: mockDoGenerate,
        params: { prompt: [] },
      } as any);

      // Should keep the original text when parsing fails
      expect(result.content[0].type).toBe("text");
    });
  });
});
