import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../core/protocols/hermes-protocol";
import { morphXmlProtocol } from "../core/protocols/morph-xml-protocol";
import { originalToolsSchema } from "../core/utils/provider-options";
import { createToolMiddleware } from "../tool-call-middleware";

describe("createToolMiddleware", () => {
  const mockToolSystemPromptTemplate = (tools: unknown[]) =>
    `You have tools: ${JSON.stringify(tools)}`;

  const createJsonMiddleware = () =>
    createToolMiddleware({
      protocol: hermesProtocol({}),
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
      expect(middleware.specificationVersion).toBe("v3");
      expect(middleware.wrapGenerate).toBeDefined();
      expect(middleware.wrapStream).toBeDefined();
      expect(middleware.transformParams).toBeDefined();
    });
  });

  describe("wrapGenerate with hermesProtocol", () => {
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

      const result = await middleware.wrapGenerate?.({
        doGenerate,
        params: { prompt: [] },
      } as any);

      const EXPECTED_CONTENT_LENGTH = 3;
      expect(result).toBeDefined();
      expect(result?.content).toHaveLength(EXPECTED_CONTENT_LENGTH);
      expect(result?.content[0]).toEqual({ type: "text", text: "Some text " });
      expect(result?.content[1]).toMatchObject({
        type: "tool-call",
        toolName: "getTool",
        input: '{"arg1":"value1"}',
      });
      expect(result?.content[2]).toEqual({ type: "text", text: " more text" });
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

      const result = await middleware.wrapGenerate?.({
        doGenerate,
        params: { prompt: [] },
      } as any);

      const EXPECTED_SINGLE_CONTENT = 1;
      expect(result).toBeDefined();
      expect(result?.content).toHaveLength(EXPECTED_SINGLE_CONTENT);
      expect(result?.content[0]).toEqual(original);
    });

    it("recovers bare JSON tool payload when protocol parsing returns no tool-call", async () => {
      const middleware = createJsonMiddleware();
      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "get_weather",
          description: "",
          inputSchema: {
            type: "object",
            properties: {
              city: { type: "string" },
              unit: { type: "string" },
            },
            required: ["city"],
            additionalProperties: false,
          },
        },
      ];
      const doGenerate = vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: '{"name":"get_weather","arguments":{"city":"Seoul","unit":"celsius"}}',
          },
        ],
      });

      const result = await middleware.wrapGenerate?.({
        doGenerate,
        params: {
          prompt: [],
          tools,
          providerOptions: {
            toolCallMiddleware: {
              originalTools: originalToolsSchema.encode(tools),
            },
          },
        },
      } as any);

      const toolCall = result?.content.find(
        (part: any) => part.type === "tool-call"
      ) as any;
      expect(toolCall).toBeTruthy();
      expect(toolCall.toolName).toBe("get_weather");
      expect(JSON.parse(toolCall.input)).toEqual({
        city: "Seoul",
        unit: "celsius",
      });
    });

    it("preserves surrounding text when JSON fallback recovers from fenced payload", async () => {
      const middleware = createJsonMiddleware();
      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "get_weather",
          description: "",
          inputSchema: {
            type: "object",
            properties: {
              city: { type: "string" },
              unit: { type: "string" },
            },
            required: ["city"],
            additionalProperties: false,
          },
        },
      ];
      const doGenerate = vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: [
              "Before",
              "```json",
              '{"name":"get_weather","arguments":{"city":"Seoul","unit":"celsius"}}',
              "```",
              "After",
            ].join("\n"),
          },
        ],
      });

      const result = await middleware.wrapGenerate?.({
        doGenerate,
        params: {
          prompt: [],
          tools,
          providerOptions: {
            toolCallMiddleware: {
              originalTools: originalToolsSchema.encode(tools),
            },
          },
        },
      } as any);

      const EXPECTED_CONTENT_LENGTH = 3;
      expect(result?.content).toHaveLength(EXPECTED_CONTENT_LENGTH);

      const [before, toolCall, after] = result?.content as any[];
      expect(before).toEqual({ type: "text", text: "Before\n" });
      expect(toolCall).toMatchObject({
        type: "tool-call",
        toolName: "get_weather",
      });
      expect(JSON.parse(toolCall.input)).toEqual({
        city: "Seoul",
        unit: "celsius",
      });
      expect(after).toEqual({ type: "text", text: "\nAfter" });
    });

    it("recovers arguments-only JSON object for single strict tool schema", async () => {
      const middleware = createJsonMiddleware();
      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "get_weather",
          description: "",
          inputSchema: {
            type: "object",
            properties: {
              city: { type: "string" },
              unit: { type: "string" },
            },
            required: ["city"],
            additionalProperties: false,
          },
        },
      ];
      const doGenerate = vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: '{"city":"Busan","unit":"celsius"}',
          },
        ],
      });

      const result = await middleware.wrapGenerate?.({
        doGenerate,
        params: {
          prompt: [],
          tools,
          providerOptions: {
            toolCallMiddleware: {
              originalTools: originalToolsSchema.encode(tools),
            },
          },
        },
      } as any);

      const toolCall = result?.content.find(
        (part: any) => part.type === "tool-call"
      ) as any;
      expect(toolCall).toBeTruthy();
      expect(toolCall.toolName).toBe("get_weather");
      expect(JSON.parse(toolCall.input)).toEqual({
        city: "Busan",
        unit: "celsius",
      });
    });

    it("does not recover arguments-only JSON when keys do not match strict schema", async () => {
      const middleware = createJsonMiddleware();
      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "get_weather",
          description: "",
          inputSchema: {
            type: "object",
            properties: {
              city: { type: "string" },
            },
            required: ["city"],
            additionalProperties: false,
          },
        },
      ];
      const doGenerate = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: '{"foo":"bar"}' }],
      });

      const result = await middleware.wrapGenerate?.({
        doGenerate,
        params: {
          prompt: [],
          tools,
          providerOptions: {
            toolCallMiddleware: {
              originalTools: originalToolsSchema.encode(tools),
            },
          },
        },
      } as any);

      expect(result?.content).toEqual([
        { type: "text", text: '{"foo":"bar"}' },
      ]);
    });
  });

  describe("wrapGenerate with morphXmlProtocol", () => {
    it("should parse XML tool calls from text content", async () => {
      const middleware = createXmlMiddleware();
      const tools: LanguageModelV3FunctionTool[] = [
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
            text: "Some text <getTool><arg1>value1</arg1></getTool> more text",
          },
        ],
      });

      const result = await middleware.wrapGenerate?.({
        doGenerate,
        params: {
          prompt: [],
          tools,
          providerOptions: {
            // INFO: Since this test does not go through the transform handler
            // that normally injects this, we need to provide it manually.
            toolCallMiddleware: {
              originalTools: originalToolsSchema.encode(tools),
            },
          },
        },
      } as any);

      const EXPECTED_XML_CONTENT_LENGTH = 3;
      expect(result).toBeDefined();
      expect(result?.content).toHaveLength(EXPECTED_XML_CONTENT_LENGTH);
      expect(result?.content[0]).toEqual({ type: "text", text: "Some text " });
      expect(result?.content[1]).toMatchObject({
        type: "tool-call",
        toolName: "getTool",
        input: '{"arg1":"value1"}',
      });
      expect(result?.content[2]).toEqual({ type: "text", text: " more text" });
    });
  });
});

describe("createToolMiddleware positive paths", () => {
  it("wrapGenerate parses text content via protocol parseGeneratedText", async () => {
    const mw = createToolMiddleware({
      protocol: hermesProtocol,
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
    const result = await mw.wrapGenerate?.({
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
    expect(result).toBeDefined();
    expect(result?.content.some((c: any) => c.type === "tool-call")).toBe(true);
  });
});
