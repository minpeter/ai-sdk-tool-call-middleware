import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { hermesToolMiddleware } from "../../preconfigured-middleware";
import { requireTransformParams } from "../test-helpers";

const REGEX_TOOL_CALL = /<tool_call>/;

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

describe("transformParams hermes tool-call signature regression", () => {
  it("preserves tool-call signature when input is undefined", async () => {
    const transformParams = requireTransformParams(
      hermesToolMiddleware.transformParams
    );

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

    expect(assistantText).toMatch(REGEX_TOOL_CALL);
    expect(assistantText).toContain("get_weather");
  });

  it("preserves tool-call signature when input is empty string", async () => {
    const transformParams = requireTransformParams(
      hermesToolMiddleware.transformParams
    );

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
                input: "",
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

  it("preserves tool-call signature when input is null", async () => {
    const transformParams = requireTransformParams(
      hermesToolMiddleware.transformParams
    );

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
                input: null,
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

  it("preserves signatures for multiple tool calls with mixed input types", async () => {
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

    const transformParams = requireTransformParams(
      hermesToolMiddleware.transformParams
    );

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
                input: JSON.stringify({ city: "Seoul" }),
              } as any,
              {
                type: "tool-call",
                toolCallId: "tc2",
                toolName: "get_time",
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

    expect(assistantText).toContain("get_weather");
    expect(assistantText).toContain("get_time");
    expect(assistantText).toMatch(REGEX_TOOL_CALL);
  });
});
