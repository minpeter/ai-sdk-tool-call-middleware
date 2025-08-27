import { describe, it, expect, vi } from "vitest";
import { createToolMiddleware } from "./tool-call-middleware";
import { jsonMixProtocol } from "./protocols/json-mix-protocol";
import { xmlProtocol } from "./protocols/xml-protocol";
import type {
  LanguageModelV2Content,
  LanguageModelV2Message,
  LanguageModelV2FunctionTool,
} from "@ai-sdk/provider";

describe("createToolMiddleware", () => {
  const mockToolSystemPromptTemplate = (tools: string) =>
    `You have tools: ${tools}`;

  const createJsonMiddleware = () =>
    createToolMiddleware({
      protocol: jsonMixProtocol({}),
      toolSystemPromptTemplate: mockToolSystemPromptTemplate,
    });

  const createXmlMiddleware = () =>
    createToolMiddleware({
      protocol: xmlProtocol,
      toolSystemPromptTemplate: mockToolSystemPromptTemplate,
    });

  describe("middleware creation", () => {
    it("should create middleware with correct properties", () => {
      const middleware = createJsonMiddleware();
      expect(middleware).toBeDefined();
      expect(middleware.middlewareVersion).toBe("v2");
      expect(middleware.wrapGenerate).toBeDefined();
      expect(middleware.wrapStream).toBeDefined();
      expect(middleware.transformParams).toBeDefined();
    });
  });

  describe("transformParams", () => {
    it("should transform params with tools into prompt", async () => {
      const middleware = createJsonMiddleware();
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
  });

  describe("wrapGenerate with jsonMixProtocol", () => {
    it("should parse tool calls from text content", async () => {
      const middleware = createJsonMiddleware();
      const doGenerate = vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: `Some text <tool_code>{"name": "getTool", "arguments": {"arg1": "value1"}}</tool_code> more text`,
          },
        ],
      });

      const result = await middleware.wrapGenerate!({
        doGenerate,
        params: { prompt: [] },
      } as any);

      expect(result.content).toHaveLength(3);
      expect(result.content[0]).toEqual({ type: "text", text: "Some text " });
      expect(result.content[1]).toMatchObject({
        type: "tool-call",
        toolName: "getTool",
        input: '{"arg1":"value1"}',
      });
      expect(result.content[2]).toEqual({ type: "text", text: " more text" });
    });
  });

  describe("wrapGenerate with xmlProtocol", () => {
    it("should parse XML tool calls from text content", async () => {
      const middleware = createXmlMiddleware();
      const tools: LanguageModelV2FunctionTool[] = [
        {
          type: "function",
          name: "getTool",
          description: "Gets a tool",
          inputSchema: { type: "object" },
        },
      ];
      const doGenerate = vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: `Some text <getTool><arg1>value1</arg1></getTool> more text`,
          },
        ],
      });

      const result = await middleware.wrapGenerate!({
        doGenerate,
        params: { prompt: [], tools },
      } as any);

      expect(result.content).toHaveLength(3);
      expect(result.content[0]).toEqual({ type: "text", text: "Some text " });
      expect(result.content[1]).toMatchObject({
        type: "tool-call",
        toolName: "getTool",
        input: '{"arg1":"value1"}',
      });
      expect(result.content[2]).toEqual({ type: "text", text: " more text" });
    });
  });
});
