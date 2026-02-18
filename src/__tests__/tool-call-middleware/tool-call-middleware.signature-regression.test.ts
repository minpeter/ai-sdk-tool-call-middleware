import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { hermesToolMiddleware, morphXmlToolMiddleware } from "../../index";

/**
 * Bug reproduction test: Tool call signatures disappear while tool responses are maintained
 *
 * When messages are transformed through the middleware, assistant messages with tool-call
 * content should be converted to text format (e.g., <tool_call>...</tool_call>).
 * However, there's a bug where tool call signatures disappear.
 */

// Regex constants for lint compliance
const REGEX_TOOL_CALL = /<tool_call>/;
const REGEX_GET_WEATHER_TAG = /<get_weather[>/]/;
const REGEX_EDIT_FILE_TAG = /<edit_file>/;

const tools: LanguageModelV3FunctionTool[] = [
  {
    type: "function",
    name: "get_weather",
    description: "Get the weather",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
    },
  },
];

describe("Bug: Tool call signatures disappear through middleware", () => {
  describe("Scenario 1: Tool call with undefined input", () => {
    it("hermes middleware should preserve tool call when input is undefined", async () => {
      const transformParams = hermesToolMiddleware.transformParams;
      if (!transformParams) {
        throw new Error("transformParams is undefined");
      }

      const out = await transformParams({
        params: {
          prompt: [
            {
              role: "user",
              content: [{ type: "text", text: "What's the weather?" }],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "tc1",
                  toolName: "get_weather",
                  input: undefined, // Bug: input is undefined
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
                  output: { temperature: 25 },
                },
              ],
            },
          ],
          tools,
        },
      } as any);

      const assistantMsg = out.prompt.find((m: any) => m.role === "assistant");
      expect(assistantMsg).toBeTruthy();

      const assistantText = (assistantMsg?.content as any[])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");

      // Should contain the tool call signature, not stringified JSON
      expect(assistantText).toMatch(REGEX_TOOL_CALL);
      expect(assistantText).toContain("get_weather");
    });
  });

  describe("Scenario 2: Tool call with empty string input", () => {
    it("should handle tool call with empty string input", async () => {
      const transformParams = hermesToolMiddleware.transformParams;
      if (!transformParams) {
        throw new Error("transformParams is undefined");
      }

      const out = await transformParams({
        params: {
          prompt: [
            {
              role: "user",
              content: [{ type: "text", text: "What's the weather?" }],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "tc1",
                  toolName: "get_weather",
                  input: "", // Empty string
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
                  output: { temperature: 25 },
                },
              ],
            },
          ],
          tools,
        },
      } as any);

      const assistantMsg = out.prompt.find((m: any) => m.role === "assistant");
      expect(assistantMsg).toBeTruthy();

      const assistantText = (assistantMsg?.content as any[])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");

      expect(assistantText).toMatch(REGEX_TOOL_CALL);
      expect(assistantText).toContain("get_weather");
    });
  });

  describe("Scenario 3: Tool call with null input", () => {
    it("should handle tool call with null input", async () => {
      const transformParams = hermesToolMiddleware.transformParams;
      if (!transformParams) {
        throw new Error("transformParams is undefined");
      }

      const out = await transformParams({
        params: {
          prompt: [
            {
              role: "user",
              content: [{ type: "text", text: "What's the weather?" }],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "tc1",
                  toolName: "get_weather",
                  input: null, // null input
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
                  output: { temperature: 25 },
                },
              ],
            },
          ],
          tools,
        },
      } as any);

      const assistantMsg = out.prompt.find((m: any) => m.role === "assistant");
      expect(assistantMsg).toBeTruthy();

      const assistantText = (assistantMsg?.content as any[])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");

      expect(assistantText).toMatch(REGEX_TOOL_CALL);
      expect(assistantText).toContain("get_weather");
    });
  });

  describe("Scenario 4: XML middleware with various input types", () => {
    it("xml middleware should preserve tool call signature with undefined input", async () => {
      const transformParams = morphXmlToolMiddleware.transformParams;
      if (!transformParams) {
        throw new Error("transformParams is undefined");
      }

      const out = await transformParams({
        params: {
          prompt: [
            {
              role: "user",
              content: [{ type: "text", text: "What's the weather?" }],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "tc1",
                  toolName: "get_weather",
                  input: undefined,
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
                  output: { temperature: 25 },
                },
              ],
            },
          ],
          tools,
        },
      } as any);

      const assistantMsg = out.prompt.find((m: any) => m.role === "assistant");
      expect(assistantMsg).toBeTruthy();

      const assistantText = (assistantMsg?.content as any[])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");

      // XML protocol uses <toolName> or <toolName/> format (self-closing when no args)
      expect(assistantText).toMatch(REGEX_GET_WEATHER_TAG);
    });
  });

  describe("Scenario 5: Tool call with object input (already parsed)", () => {
    it("should preserve tool call when input is an object instead of string", async () => {
      const transformParams = morphXmlToolMiddleware.transformParams;
      if (!transformParams) {
        throw new Error("transformParams is undefined");
      }

      const out = await transformParams({
        params: {
          prompt: [
            {
              role: "user",
              content: [{ type: "text", text: "Edit the file" }],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "tc1",
                  toolName: "edit_file",
                  // input as object, not string - this might happen with some AI SDK versions
                  input: {
                    path: "/test/file.ts",
                    old_str: "foo",
                    new_str: "bar",
                    replace_all: false,
                  },
                } as any,
              ],
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolName: "edit_file",
                  toolCallId: "tc1",
                  output: { success: true },
                },
              ],
            },
          ],
          tools: [
            {
              type: "function",
              name: "edit_file",
              description: "Edit a file",
              inputSchema: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  old_str: { type: "string" },
                  new_str: { type: "string" },
                  replace_all: { type: "boolean" },
                },
              },
            },
          ],
        },
      } as any);

      const assistantMsg = out.prompt.find((m: any) => m.role === "assistant");
      expect(assistantMsg).toBeTruthy();

      const assistantText = (assistantMsg?.content as any[])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");

      // Should contain the tool call, not be empty or just stringified JSON
      expect(assistantText).toMatch(REGEX_EDIT_FILE_TAG);
      expect(assistantText).toContain("path");
    });
  });

  describe("Scenario 6: Multiple tool calls with mixed input types", () => {
    it("should preserve all tool call signatures", async () => {
      const multiTools: LanguageModelV3FunctionTool[] = [
        ...tools,
        {
          type: "function",
          name: "get_time",
          description: "Get the time",
          inputSchema: {
            type: "object",
            properties: { timezone: { type: "string" } },
          },
        },
      ];

      const transformParams = hermesToolMiddleware.transformParams;
      if (!transformParams) {
        throw new Error("transformParams is undefined");
      }

      const out = await transformParams({
        params: {
          prompt: [
            {
              role: "user",
              content: [{ type: "text", text: "Weather and time?" }],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "tc1",
                  toolName: "get_weather",
                  input: JSON.stringify({ city: "Seoul" }), // Valid input
                } as any,
                {
                  type: "tool-call",
                  toolCallId: "tc2",
                  toolName: "get_time",
                  input: undefined, // Undefined input - this might cause issues
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
                  output: { temperature: 25 },
                },
                {
                  type: "tool-result",
                  toolName: "get_time",
                  toolCallId: "tc2",
                  output: { time: "10:00 AM" },
                },
              ],
            },
          ],
          tools: multiTools,
        },
      } as any);

      const assistantMsg = out.prompt.find((m: any) => m.role === "assistant");
      expect(assistantMsg).toBeTruthy();

      const assistantText = (assistantMsg?.content as any[])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");

      // Both tool calls should be preserved
      expect(assistantText).toContain("get_weather");
      expect(assistantText).toContain("get_time");
      // Should have proper format, not stringified JSON fallback
      expect(assistantText).toMatch(REGEX_TOOL_CALL);
    });
  });
});
