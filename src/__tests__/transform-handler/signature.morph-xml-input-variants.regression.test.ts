import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { morphXmlToolMiddleware } from "../../preconfigured-middleware";
import { requireTransformParams } from "../test-helpers";

const REGEX_GET_WEATHER_TAG = /<get_weather[>/]/;
const REGEX_EDIT_FILE_TAG = /<edit_file>/;

const weatherTools: LanguageModelV3FunctionTool[] = [
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

describe("transformParams morph-xml tool-call signature regression", () => {
  it("preserves morph-xml tool-call signature when input is undefined", async () => {
    const transformParams = requireTransformParams(
      morphXmlToolMiddleware.transformParams
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
        tools: weatherTools,
      },
    } as any);

    const assistantMsg = out.prompt.find((m: any) => m.role === "assistant");
    expect(assistantMsg).toBeTruthy();

    const assistantText = (assistantMsg?.content as any[])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("");

    expect(assistantText).toMatch(REGEX_GET_WEATHER_TAG);
  });

  it("preserves tool-call signature when input is object", async () => {
    const transformParams = requireTransformParams(
      morphXmlToolMiddleware.transformParams
    );

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

    expect(assistantText).toMatch(REGEX_EDIT_FILE_TAG);
    expect(assistantText).toContain("path");
  });
});
