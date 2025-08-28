import { describe, it, expect } from "vitest";
import {
  gemmaToolMiddleware,
  hermesToolMiddleware,
  xmlToolMiddleware,
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

  describe("xmlToolMiddleware", () => {
    it("should be defined", () => {
      expect(xmlToolMiddleware).toBeDefined();
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

      const result = await xmlToolMiddleware.wrapGenerate!({
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

      const result = await xmlToolMiddleware.wrapGenerate!({
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

  describe("non-stream assistant->user merge formatting with object input", () => {
    it("gemma: formats assistant tool-call (object input) and tool result into user text", async () => {
      const mw = gemmaToolMiddleware;

      const out = await mw.transformParams!({
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
                  // simulate provider giving parsed object input
                  input: JSON.stringify({ city: "Seoul" }),
                } as any,
              ],
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolName: "get_weather",
                  toolCallId: "tc1",
                  output: { ok: true },
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
      } as any);

      // last message is the tool result
      console.debug(out.prompt[out.prompt.length - 1]);

      const assistantMsg = out.prompt.find((m: any) => m.role === "assistant")!;
      const assistantText = (assistantMsg.content as any[])
        .map((c: any) => (c.type === "text" ? c.text : ""))
        .join("");
      expect(assistantText).toMatch(/tool_call/);

      const userMsgs = out.prompt.filter((m: any) => m.role === "user");
      const userCombined = userMsgs
        .map((u: any) =>
          u.content.map((c: any) => (c.type === "text" ? c.text : "")).join("")
        )
        .join("\n");

      expect(userCombined).toMatch(/tool_response/);
    });

    it("hermes: formats assistant tool-call (object input) and tool result into user text", async () => {
      const mw = hermesToolMiddleware;
      const out = await mw.transformParams!({
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
                } as any,
              ],
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolName: "get_weather",
                  toolCallId: "tc1",
                  output: { ok: true },
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
      } as any);

      // last message is the tool result
      console.debug(out.prompt[out.prompt.length - 1]);

      const assistantMsg = out.prompt.find((m: any) => m.role === "assistant")!;
      const assistantText = (assistantMsg.content as any[])
        .map((c: any) => (c.type === "text" ? c.text : ""))
        .join("");
      expect(assistantText).toMatch(/<tool_call>/);

      const userMsgs = out.prompt.filter((m: any) => m.role === "user");
      const userCombined = userMsgs
        .map((u: any) =>
          u.content.map((c: any) => (c.type === "text" ? c.text : "")).join("")
        )
        .join("\n");
      expect(userCombined).toMatch(/<tool_response>/);
    });

    it("xml: formats assistant tool-call (object input) and tool result into user text", async () => {
      const mw = xmlToolMiddleware;
      const out = await mw.transformParams!({
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
                } as any,
              ],
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolName: "get_weather",
                  toolCallId: "tc1",
                  output: { ok: true },
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
      } as any);

      // last message is the tool result
      console.debug(out.prompt[out.prompt.length - 1]);

      const assistantMsg = out.prompt.find((m: any) => m.role === "assistant")!;
      const assistantText = (assistantMsg.content as any[])
        .map((c: any) => (c.type === "text" ? c.text : ""))
        .join("");
      expect(assistantText).toMatch(/<get_weather>/);

      const userMsgs = out.prompt.filter((m: any) => m.role === "user");
      const userCombined = userMsgs
        .map((u: any) =>
          u.content.map((c: any) => (c.type === "text" ? c.text : "")).join("")
        )
        .join("\n");
      expect(userCombined).toMatch(/<tool_response>/);
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
