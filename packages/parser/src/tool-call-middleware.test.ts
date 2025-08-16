import { describe, it, expect, vi } from "vitest";
import { createToolMiddleware } from "./tool-call-middleware";
import type {
  LanguageModelV2Content,
  LanguageModelV2Message,
} from "@ai-sdk/provider";

describe("createToolMiddleware", () => {
  const mockToolCallTag = "<tool_call>";
  const mockToolCallEndTag = "</tool_call>";
  const mockToolResponseTag = "<tool_response>";
  const mockToolResponseEndTag = "</tool_response>";
  const mockToolSystemPromptTemplate = (tools: string) =>
    `You have tools: ${tools}`;

  const createMiddleware = () =>
    createToolMiddleware({
      toolCallTag: mockToolCallTag,
      toolCallEndTag: mockToolCallEndTag,
      toolResponseTag: mockToolResponseTag,
      toolResponseEndTag: mockToolResponseEndTag,
      toolSystemPromptTemplate: mockToolSystemPromptTemplate,
    });

  describe("middleware creation", () => {
    it("should create middleware with correct properties", () => {
      const middleware = createMiddleware();
      expect(middleware).toBeDefined();
      expect(middleware.middlewareVersion).toBe("v2");
      expect(middleware.wrapGenerate).toBeDefined();
      expect(middleware.wrapStream).toBeDefined();
      expect(middleware.transformParams).toBeDefined();
    });
  });

  describe("transformParams", () => {
    it("should transform params with tools into prompt", async () => {
      const middleware = createMiddleware();
      const params = {
        prompt: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: "test" }],
          },
        ],
        tools: [
          {
            type: "function" as const,
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

      const result = await middleware.transformParams!({ params } as any);
      expect(result.prompt).toBeDefined();
      expect(result.tools).toEqual([]);
      expect(result.toolChoice).toBeUndefined();
    });

    it("should throw error for 'none' toolChoice type", async () => {
      const middleware = createMiddleware();
      const params = {
        prompt: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: "test" }],
          },
        ],
        tools: [],
        toolChoice: { type: "none" as const },
      };

      await expect(
        middleware.transformParams!({ params } as any)
      ).rejects.toThrow(
        "The 'none' toolChoice type is not supported by this middleware"
      );
    });

    it("should handle 'tool' toolChoice type", async () => {
      const middleware = createMiddleware();
      const params = {
        prompt: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: "test" }],
          },
        ],
        tools: [
          {
            type: "function" as const,
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
        toolChoice: { type: "tool" as const, toolName: "getTool" },
      };

      const result = await middleware.transformParams!({ params } as any);
      expect(result.responseFormat).toBeDefined();
      expect(result.responseFormat?.type).toBe("json");
      if (result.responseFormat?.type === "json") {
        expect(result.responseFormat.schema).toBeDefined();
      }
      expect(result.providerOptions).toEqual({
        toolCallMiddleware: {
          toolChoice: params.toolChoice,
        },
      });
    });

    it("should throw error for unknown tool name in toolChoice", async () => {
      const middleware = createMiddleware();
      const params = {
        prompt: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: "test" }],
          },
        ],
        tools: [
          {
            type: "function" as const,
            name: "getTool",
            inputSchema: { type: "object" },
          },
        ],
        toolChoice: { type: "tool" as const, toolName: "unknownTool" },
      };

      await expect(
        middleware.transformParams!({ params } as any)
      ).rejects.toThrow(
        "Tool with name 'unknownTool' not found in params.tools"
      );
    });

    it("should throw error for provider-defined tool in toolChoice", async () => {
      const middleware = createMiddleware();
      const params = {
        prompt: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: "test" }],
          },
        ],
        tools: [
          {
            type: "provider-defined" as const,
            id: "tool1",
          },
        ],
        toolChoice: { type: "tool" as const, toolName: "tool1" },
      };

      await expect(
        middleware.transformParams!({ params } as any)
      ).rejects.toThrow(
        "Provider-defined tools are not supported by this middleware"
      );
    });

    it("should handle 'required' toolChoice type", async () => {
      const middleware = createMiddleware();
      const params = {
        prompt: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: "test" }],
          },
        ],
        tools: [
          {
            type: "function" as const,
            name: "getTool",
            inputSchema: { type: "object" },
          },
        ],
        toolChoice: { type: "required" as const },
      };

      const result = await middleware.transformParams!({ params } as any);
      expect(result.responseFormat).toBeDefined();
      expect(result.responseFormat?.type).toBe("json");
      expect(result.providerOptions).toEqual({
        toolCallMiddleware: {
          toolChoice: { type: "required" },
        },
      });
    });

    it("should throw error for 'required' with no tools", async () => {
      const middleware = createMiddleware();
      const params = {
        prompt: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: "test" }],
          },
        ],
        tools: [],
        toolChoice: { type: "required" as const },
      };

      await expect(
        middleware.transformParams!({ params } as any)
      ).rejects.toThrow(
        "Tool choice type 'required' is set, but no tools are provided"
      );
    });
  });

  describe("wrapGenerate", () => {
    it("should handle empty content", async () => {
      const middleware = createMiddleware();
      const doGenerate = vi.fn().mockResolvedValue({
        content: [],
      });

      const result = await middleware.wrapGenerate!({
        doGenerate,
        params: { prompt: [] },
      } as any);

      expect(result.content).toEqual([]);
    });

    it("should parse tool calls from text content", async () => {
      const middleware = createMiddleware();
      const doGenerate = vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: `Some text ${mockToolCallTag}{"name": "getTool", "arguments": {"arg1": "value1"}}${mockToolCallEndTag} more text`,
          },
        ],
      });

      const result = await middleware.wrapGenerate!({
        doGenerate,
        params: { prompt: [] },
      } as any);

      expect(result.content).toHaveLength(3);
      expect(result.content[0]).toEqual({
        type: "text",
        text: "Some text ",
      });
      expect(result.content[1]).toMatchObject({
        type: "tool-call",
        toolName: "getTool",
        input: '{"arg1":"value1"}',
      });
      expect(result.content[2]).toEqual({
        type: "text",
        text: " more text",
      });
    });

    it("should handle multiple tool calls", async () => {
      const middleware = createMiddleware();
      const doGenerate = vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: `${mockToolCallTag}{"name": "tool1", "arguments": {}}${mockToolCallEndTag} ${mockToolCallTag}{"name": "tool2", "arguments": {"key": "value"}}${mockToolCallEndTag}`,
          },
        ],
      });

      const result = await middleware.wrapGenerate!({
        doGenerate,
        params: { prompt: [] },
      } as any);

      const toolCalls = result.content.filter(
        (c): c is Extract<LanguageModelV2Content, { type: "tool-call" }> =>
          c.type === "tool-call"
      );
      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0]).toMatchObject({
        type: "tool-call",
        toolName: "tool1",
        input: "{}",
      });
      expect(toolCalls[1]).toMatchObject({
        type: "tool-call",
        toolName: "tool2",
        input: '{"key":"value"}',
      });
    });

    it("should handle tool choice active scenario", async () => {
      const middleware = createMiddleware();
      const doGenerate = vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: '{"name": "getTool", "arguments": {"arg1": "value1"}}',
          },
        ],
      });

      const params = {
        prompt: [] as LanguageModelV2Message[],
        providerOptions: {
          toolCallMiddleware: {
            toolChoice: { type: "tool" as const, toolName: "getTool" },
          },
        },
      };

      const result = await middleware.wrapGenerate!({
        doGenerate,
        params,
      } as any);

      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toMatchObject({
        type: "tool-call",
        toolCallType: "function",
        toolName: "getTool",
        input: '{"arg1":"value1"}',
      });
    });

    it("should handle malformed tool calls gracefully", async () => {
      const middleware = createMiddleware();
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      const doGenerate = vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: `${mockToolCallTag}invalid json${mockToolCallEndTag}`,
          },
        ],
      });

      const result = await middleware.wrapGenerate!({
        doGenerate,
        params: { prompt: [] },
      } as any);

      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(consoleWarnSpy).toHaveBeenCalled();
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: `${mockToolCallTag}invalid json${mockToolCallEndTag}`,
      });

      consoleErrorSpy.mockRestore();
      consoleWarnSpy.mockRestore();
    });

    it("should handle partial tool call tags", async () => {
      const middleware = createMiddleware();
      const doGenerate = vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: `${mockToolCallTag}{"name": "getTool", "arguments": {}}`,
          },
        ],
      });

      const result = await middleware.wrapGenerate!({
        doGenerate,
        params: { prompt: [] },
      } as any);

      expect(result.content.length).toBeGreaterThan(0);
    });

    it("should skip non-text content items", async () => {
      const middleware = createMiddleware();
      const doGenerate = vi.fn().mockResolvedValue({
        content: [
          { type: "image", image: "data:image/png;base64,..." },
          {
            type: "text",
            text: `${mockToolCallTag}{"name": "getTool", "arguments": {}}${mockToolCallEndTag}`,
          },
        ],
      });

      const result = await middleware.wrapGenerate!({
        doGenerate,
        params: { prompt: [] },
      } as any);

      expect(result.content[0]).toMatchObject({
        type: "image",
      });
      expect(result.content[1]).toMatchObject({
        type: "tool-call",
        toolName: "getTool",
      });
    });

    it("should handle tool calls with string arguments", async () => {
      const middleware = createMiddleware();
      const doGenerate = vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: `${mockToolCallTag}{"name": "getTool", "arguments": "string_arg"}${mockToolCallEndTag}`,
          },
        ],
      });

      const result = await middleware.wrapGenerate!({
        doGenerate,
        params: { prompt: [] },
      } as any);

      const toolCall = result.content.find(
        (c): c is Extract<LanguageModelV2Content, { type: "tool-call" }> =>
          c.type === "tool-call"
      );
      expect(toolCall).toMatchObject({
        type: "tool-call",
        toolName: "getTool",
        input: "string_arg",
      });
    });

    it("should preserve text with only whitespace between tool calls", async () => {
      const middleware = createMiddleware();
      const doGenerate = vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: `Text before ${mockToolCallTag}{"name": "tool1", "arguments": {}}${mockToolCallEndTag}    ${mockToolCallTag}{"name": "tool2", "arguments": {}}${mockToolCallEndTag} text after`,
          },
        ],
      });

      const result = await middleware.wrapGenerate!({
        doGenerate,
        params: { prompt: [] },
      } as any);

      const textItems = result.content.filter(
        (c): c is Extract<LanguageModelV2Content, { type: "text" }> =>
          c.type === "text"
      );
      const toolItems = result.content.filter(
        (c): c is Extract<LanguageModelV2Content, { type: "tool-call" }> =>
          c.type === "tool-call"
      );

      expect(textItems).toHaveLength(2);
      expect(toolItems).toHaveLength(2);
      expect(textItems[0].text).toBe("Text before ");
      expect(textItems[1].text).toBe(" text after");
    });
  });

  describe("wrapStream", () => {
    it("should use toolChoiceStream when tool choice is active", async () => {
      const middleware = createMiddleware();
      const doStream = vi.fn();
      const doGenerate = vi.fn();
      const params = {
        prompt: [] as LanguageModelV2Message[],
        providerOptions: {
          toolCallMiddleware: {
            toolChoice: { type: "required" as const },
          },
        },
      };

      await middleware.wrapStream!({
        doStream,
        doGenerate,
        params,
      } as any);

      expect(doGenerate).toHaveBeenCalled();
      expect(doStream).not.toHaveBeenCalled();
    });

    it("should use normalToolStream when tool choice is not active", async () => {
      const middleware = createMiddleware();
      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          yield { type: "text", content: "test" };
        },
      };
      const doStream = vi.fn().mockResolvedValue(mockStream);
      const doGenerate = vi.fn();
      const params = { prompt: [] as LanguageModelV2Message[] };

      const result = await middleware.wrapStream!({
        doStream,
        doGenerate,
        params,
      } as any);

      expect(doStream).toHaveBeenCalled();
      expect(doGenerate).not.toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("should detect tool choice for specific tool", async () => {
      const middleware = createMiddleware();
      const doStream = vi.fn();
      const doGenerate = vi.fn();
      const params = {
        prompt: [] as LanguageModelV2Message[],
        providerOptions: {
          toolCallMiddleware: {
            toolChoice: { type: "tool" as const, toolName: "myTool" },
          },
        },
      };

      await middleware.wrapStream!({
        doStream,
        doGenerate,
        params,
      } as any);

      expect(doGenerate).toHaveBeenCalled();
      expect(doStream).not.toHaveBeenCalled();
    });
  });

  describe("isToolChoiceActive helper", () => {
    it("should return false for undefined providerOptions", () => {
      const middleware = createMiddleware();
      const doGenerate = vi.fn().mockResolvedValue({ content: [] });

      middleware.wrapGenerate!({
        doGenerate,
        params: { prompt: [] },
      } as any);

      expect(doGenerate).toHaveBeenCalled();
    });

    it("should return false for null providerOptions", () => {
      const middleware = createMiddleware();
      const doGenerate = vi.fn().mockResolvedValue({ content: [] });

      middleware.wrapGenerate!({
        doGenerate,
        params: { prompt: [], providerOptions: undefined },
      } as any);

      expect(doGenerate).toHaveBeenCalled();
    });

    it("should return false for invalid toolChoice type", () => {
      const middleware = createMiddleware();
      const doGenerate = vi.fn().mockResolvedValue({ content: [] });

      middleware.wrapGenerate!({
        doGenerate,
        params: {
          prompt: [] as LanguageModelV2Message[],
          providerOptions: {
            toolCallMiddleware: {
              toolChoice: { type: "auto" },
            },
          },
        },
      } as any);

      expect(doGenerate).toHaveBeenCalled();
    });
  });
});
