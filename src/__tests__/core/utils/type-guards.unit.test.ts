import { describe, expect, it } from "vitest";

import { isToolResultPart } from "../../../core/utils/type-guards";

describe("type-guards", () => {
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
