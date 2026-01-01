import { describe, expect, it, vi } from "vitest";

import { morphXmlProtocol } from "../../core/protocols/morph-xml-protocol";

vi.spyOn(console, "warn").mockImplementation(() => {
  // Intentionally empty - suppressing console warnings in tests
});

describe("morphXmlProtocol parseGeneratedText branches", () => {
  const tools = [
    {
      type: "function",
      name: "a",
      description: "",
      inputSchema: { type: "object" },
    },
  ] as any;

  it("returns original text when tools list is empty", () => {
    const p = morphXmlProtocol();
    const out = p.parseGeneratedText({
      text: "free text",
      tools: [],
      options: {},
    });
    expect(out).toEqual([{ type: "text", text: "free text" }]);
  });

  it("handles malformed inner XML gracefully (either falls back to text or parses)", () => {
    const p = morphXmlProtocol();
    const text = "<a><x></y></a>";
    const out = p.parseGeneratedText({ text, tools, options: {} });
    const hasText = out.some((c) => c.type === "text");
    const hasTool = out.some((c) => c.type === "tool-call");
    expect(hasText || hasTool).toBe(true);
  });
});
