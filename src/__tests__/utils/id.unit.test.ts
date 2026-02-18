import { describe, expect, it } from "vitest";
import { generateToolCallId } from "../../core/utils/id";

const TOOL_CALL_ID_RE = /^call_[A-Za-z0-9]{24}$/;

describe("tool call id format", () => {
  it("generates OpenAI-like call_ prefixed ids", () => {
    const id = generateToolCallId();
    expect(id).toMatch(TOOL_CALL_ID_RE);
  });
});
