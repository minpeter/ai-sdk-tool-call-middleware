import { describe, it, expect } from "vitest";
import {
  gemmaToolMiddleware,
  hermesToolMiddleware,
  korinaiToolMiddleware,
  createToolMiddleware,
  jsonMixProtocol,
  xmlProtocol,
} from "./index";
import type {
  LanguageModelV2Message,
  LanguageModelV2FunctionTool,
  LanguageModelV2Content,
} from "@ai-sdk/provider";

describe("index exports", () => {
  describe("gemmaToolMiddleware", () => {
    it("should be defined", () => {
      expect(gemmaToolMiddleware).toBeDefined();
    });
  });

  describe("hermesToolMiddleware", () => {
    it("should be defined", () => {
      expect(hermesToolMiddleware).toBeDefined();
    });
  });

  describe("korinaiToolMiddleware", () => {
    it("should be defined", () => {
      expect(korinaiToolMiddleware).toBeDefined();
    });

    it("should parse XML tool calls", async () => {
      const mockDoGenerate = () =>
        Promise.resolve({
          content: [
            {
              type: "text" as const,
              text: `<get_weather><location>San Francisco</location></get_weather>`,
            },
          ] as LanguageModelV2Content[],
        });

      const result = await korinaiToolMiddleware.wrapGenerate!({
        doGenerate: mockDoGenerate,
        params: {
          prompt: [],
          tools: [
            {
              type: "function",
              name: "get_weather",
              description: "Get the weather",
              inputSchema: { type: "object" },
            },
          ],
        },
      } as any);

      const toolCalls = result.content.filter(
        (c): c is Extract<LanguageModelV2Content, { type: "tool-call" }> =>
          c.type === "tool-call"
      );
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].toolName).toBe("get_weather");
      expect(JSON.parse(toolCalls[0].input)).toEqual({
        location: "San Francisco",
      });
    });

    it("should parse XML tool calls with no arguments", async () => {
      const mockDoGenerate = () =>
        Promise.resolve({
          content: [
            {
              type: "text" as const,
              text: `<get_location></get_location>`,
            },
          ] as LanguageModelV2Content[],
        });

      const result = await korinaiToolMiddleware.wrapGenerate!({
        doGenerate: mockDoGenerate,
        params: {
          prompt: [],
          tools: [
            {
              type: "function",
              name: "get_location",
              description: "Get the user's location",
              inputSchema: { type: "object" },
            },
          ],
        },
      } as any);

      const toolCalls = result.content.filter(
        (c): c is Extract<LanguageModelV2Content, { type: "tool-call" }> =>
          c.type === "tool-call"
      );
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].toolName).toBe("get_location");
      expect(JSON.parse(toolCalls[0].input)).toEqual({});
    });
  });

  describe("createToolMiddleware export", () => {
    it("should be exported and callable", () => {
      expect(createToolMiddleware).toBeDefined();
      expect(typeof createToolMiddleware).toBe("function");
    });

    it("should create custom middleware", () => {
      const customMiddleware = createToolMiddleware({
        protocol: jsonMixProtocol(), // or xmlProtocol
        toolSystemPromptTemplate: (tools: string) =>
          `Custom template: ${tools}`,
      });

      expect(customMiddleware).toBeDefined();
      expect(customMiddleware.middlewareVersion).toBe("v2");
    });
  });
});
