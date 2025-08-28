import { describe, it, expect, vi } from "vitest";
import { xmlProtocol } from "./xml-protocol";

vi.spyOn(console, "warn").mockImplementation(() => {});

describe("xmlProtocol parseGeneratedText branches", () => {
  const tools = [
    {
      type: "function",
      name: "a",
      description: "",
      inputSchema: { type: "object" },
    },
  ] as any;

  it("returns original text when tools list is empty", () => {
    const p = xmlProtocol();
    const out = p.parseGeneratedText({
      text: "free text",
      tools: [],
      options: {},
    });
    expect(out).toEqual([{ type: "text", text: "free text" }]);
  });

  it("handles malformed inner XML gracefully (either falls back to text or parses)", () => {
    const p = xmlProtocol();
    const text = "<a><x></y></a>";
    const out = p.parseGeneratedText({ text, tools, options: {} });
    const hasText = out.some(c => c.type === "text");
    const hasTool = out.some(c => c.type === "tool-call");
    expect(hasText || hasTool).toBe(true);
  });
});
