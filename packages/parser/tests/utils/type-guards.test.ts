import { describe, it, expect } from "vitest";
import { isToolCallContent, isToolResultPart } from "@/utils/type-guards";

describe("type-guards", () => {
  it("isToolCallContent returns true for valid tool-call", () => {
    const content = {
      type: "tool-call",
      toolName: "get_weather",
      input: "{}",
    };
    expect(isToolCallContent(content)).toBe(true);
  });

  it("isToolCallContent returns false for invalid shapes", () => {
    expect(isToolCallContent({})).toBe(false);
    expect(isToolCallContent({ type: "tool-call", toolName: 1 })).toBe(false);
    expect(isToolCallContent({ type: "text", text: "hi" })).toBe(false);
  });

  it("isToolResultPart returns true for valid tool-result", () => {
    const part = {
      type: "tool-result",
      toolName: "get_weather",
      toolCallId: "id-1",
      output: { ok: true },
    };
    expect(isToolResultPart(part)).toBe(true);
  });

  it("isToolResultPart returns false for invalid shapes", () => {
    expect(isToolResultPart({})).toBe(false);
    expect(
      isToolResultPart({ type: "tool-result", toolName: "x", output: 1 })
    ).toBe(false);
  });
});
