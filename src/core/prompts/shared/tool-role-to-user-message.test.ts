import type { ToolContent } from "@ai-sdk/provider-utils";
import { describe, expect, it } from "vitest";
import {
  createUserContentToolResponseTemplate,
  toolRoleContentToUserTextMessage,
} from "./tool-role-to-user-message";

describe("toolRoleContentToUserTextMessage", () => {
  it("converts tool-result and approval responses into a single user text message", () => {
    const result = toolRoleContentToUserTextMessage({
      toolContent: [
        {
          type: "tool-result",
          toolCallId: "tc1",
          toolName: "get_weather",
          output: { type: "json", value: { temperature: 21 } },
        },
        {
          type: "tool-approval-response",
          toolCallId: "tc1",
          approved: false,
          reason: "Not allowed",
        },
      ] as ToolContent,
      toolResponsePromptTemplate: () =>
        '<tool_response>\n{"temperature":21}\n</tool_response>',
    });

    expect(result).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: '<tool_response>\n{"temperature":21}\n</tool_response>\n[Tool Approval Denied: Not allowed]',
        },
      ],
    });
  });

  it("supports model media mode and emits file parts for user content", () => {
    const result = toolRoleContentToUserTextMessage({
      toolContent: [
        {
          type: "tool-result",
          toolCallId: "tc1",
          toolName: "vision",
          output: {
            type: "content",
            value: [{ type: "image-url", url: "https://example.com/a.png" }],
          },
        },
      ] as ToolContent,
      toolResponsePromptTemplate: createUserContentToolResponseTemplate({
        mediaStrategy: {
          mode: "model",
        },
      }),
    });

    expect(result).toEqual({
      role: "user",
      content: [
        {
          type: "file",
          data: "https://example.com/a.png",
          mediaType: "image/*",
        },
      ],
    });
  });

  it("does not merge adjacent text parts when providerOptions are present", () => {
    const result = toolRoleContentToUserTextMessage({
      toolContent: [
        {
          type: "tool-result",
          toolCallId: "tc1",
          toolName: "get_weather",
          output: { type: "json", value: { temperature: 21 } },
        },
      ] as ToolContent,
      toolResponsePromptTemplate: () => [
        {
          type: "text",
          text: "first",
          providerOptions: { providerA: { mode: "x" } },
        },
        {
          type: "text",
          text: "second",
          providerOptions: { providerA: { mode: "y" } },
        },
      ],
    });

    expect(result).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "first",
          providerOptions: { providerA: { mode: "x" } },
        },
        {
          type: "text",
          text: "second",
          providerOptions: { providerA: { mode: "y" } },
        },
      ],
    });
  });
});
