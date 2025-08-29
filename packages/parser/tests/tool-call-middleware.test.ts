import type { LanguageModelV2FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { jsonMixProtocol } from "@/protocols/json-mix-protocol";
import { morphXmlProtocol } from "@/protocols/morph-xml-protocol";
import { createToolMiddleware } from "@/tool-call-middleware";

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
      protocol: morphXmlProtocol,
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

  describe("wrapGenerate with jsonMixProtocol", () => {
    it("should parse tool calls from text content", async () => {
      const middleware = createJsonMiddleware();
      const doGenerate = vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: `Some text <tool_call>{"name": "getTool", "arguments": {"arg1": "value1"}}</tool_call> more text`,
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

    it("should pass through non-text content unchanged", async () => {
      const middleware = createJsonMiddleware();
      const original = {
        type: "tool-call" as const,
        toolCallId: "id1",
        toolName: "t",
        input: "{}",
      };
      const doGenerate = vi.fn().mockResolvedValue({
        content: [original],
      });

      const result = await middleware.wrapGenerate!({
        doGenerate,
        params: { prompt: [] },
      } as any);

      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toEqual(original);
    });
  });

  describe("wrapGenerate with morphXmlProtocol", () => {
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

describe("createToolMiddleware positive paths", () => {
  it("wrapGenerate parses text content via protocol parseGeneratedText", async () => {
    const mw = createToolMiddleware({
      protocol: jsonMixProtocol,
      toolSystemPromptTemplate: () => "",
    });
    const doGenerate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: '<tool_call>{"name":"t","arguments":{}}</tool_call>',
        },
      ],
    });
    const result = await mw.wrapGenerate!({
      doGenerate,
      params: {
        prompt: [],
        tools: [
          {
            type: "function",
            name: "t",
            description: "",
            inputSchema: { type: "object" },
          },
        ],
      },
    } as any);
    expect(result.content.some((c: any) => c.type === "tool-call")).toBe(true);
  });
});
