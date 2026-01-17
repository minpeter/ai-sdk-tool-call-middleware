import { describe, expect, it, vi } from "vitest";

import { xmlProtocol } from "../../core/protocols/xml-protocol";

vi.spyOn(console, "warn").mockImplementation(() => {
  // Intentionally empty - suppressing console warnings in tests
});

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
    const hasText = out.some((c) => c.type === "text");
    const hasTool = out.some((c) => c.type === "tool-call");
    expect(hasText || hasTool).toBe(true);
  });

  it("parses tool calls with whitespace in the closing tag name", () => {
    const p = xmlProtocol();
    const text = "<a><x>ok</x></ a>";
    const out = p.parseGeneratedText({ text, tools, options: {} });
    const tool = out.find((c) => c.type === "tool-call") as any;
    expect(tool).toBeTruthy();
  });

  it("parses empty tool call bodies when repair is disabled", () => {
    const p = xmlProtocol({ parseOptions: { repair: false } });
    const text = "<a></a>";
    const out = p.parseGeneratedText({ text, tools, options: {} });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "tool-call",
      toolName: "a",
      input: "{}",
    });
  });

  it("treats HTML-void tag names like <input> as normal XML nodes", () => {
    const p = xmlProtocol();
    const localTools = [
      {
        type: "function",
        name: "with_input",
        description: "",
        inputSchema: {
          type: "object",
          properties: {
            input: { type: "string" },
          },
          required: ["input"],
        },
      },
    ] as any;
    const text = "<with_input><input>hello</input></with_input>";
    const out = p.parseGeneratedText({ text, tools: localTools, options: {} });
    const tool = out.find((c) => c.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    const args = JSON.parse(tool.input);
    expect(args.input).toBe("hello");
  });
});
