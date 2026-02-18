import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

describe("protocol error paths", () => {
  it("hermesProtocol parseGeneratedText calls onError and preserves text on bad JSON", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text = "before <tool_call>{invalid}</tool_call> after";
    const out = p.parseGeneratedText({ text, tools: [], options: { onError } });
    expect(onError).toHaveBeenCalled();
    const rejoined = out
      .map((x) => (x.type === "text" ? (x as any).text : ""))
      .join("");
    expect(rejoined).toContain("<tool_call>{invalid}</tool_call>");
  });
});
