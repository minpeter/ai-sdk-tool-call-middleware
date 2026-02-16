import type { ToolContent } from "@ai-sdk/provider-utils";
import { describe, expect, it } from "vitest";
import { toolRoleContentToUserTextMessage } from "./tool-role-user-text";

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
});
