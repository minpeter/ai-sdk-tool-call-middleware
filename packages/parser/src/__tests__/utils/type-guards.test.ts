import { describe, expect, it } from "vitest";

import {
  isToolCallContent,
  isToolResultPart,
} from "../../core/utils/type-guards";

describe("type-guards", () => {
  it("isToolCallContent returns true for valid tool-call", () => {
    const content = {
      type: "tool-call",
      toolName: "get_weather",
      input: "{}",
    };
    expect(isToolCallContent(content)).toBe(true);
  });

  it("isToolCallContent returns false for non-tool-call types", () => {
    expect(isToolCallContent({})).toBe(false);
    expect(isToolCallContent({ type: "text", text: "hi" })).toBe(false);
    expect(isToolCallContent({ type: "tool-result" })).toBe(false);
  });

  it("isToolCallContent returns false when toolName is missing or invalid", () => {
    expect(isToolCallContent({ type: "tool-call" })).toBe(false);
    expect(isToolCallContent({ type: "tool-call", toolName: 123 })).toBe(false);
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
