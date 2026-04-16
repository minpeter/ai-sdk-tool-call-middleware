import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

describe("parseGeneratedText control character normalization", () => {
  it("parses tool call with raw newline in argument value", () => {
    const p = hermesProtocol();
    const text = `<tool_call>{"name":"edit","arguments":{"content":"line1\nline2"}}</tool_call>`;
    const out = p.parseGeneratedText({ text, tools: [] });
    const tool = out.find((x) => x.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(tool.toolName).toBe("edit");
    expect(JSON.parse(tool.input).content).toBe("line1\nline2");
  });

  it("parses tool call with raw tab in argument value", () => {
    const p = hermesProtocol();
    const text = `<tool_call>{"name":"edit","arguments":{"content":"col1\tcol2"}}</tool_call>`;
    const out = p.parseGeneratedText({ text, tools: [] });
    const tool = out.find((x) => x.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(JSON.parse(tool.input).content).toBe("col1\tcol2");
  });

  it("parses tool call with raw carriage return in argument value", () => {
    const p = hermesProtocol();
    const text = `<tool_call>{"name":"edit","arguments":{"content":"line1\r\nline2"}}</tool_call>`;
    const out = p.parseGeneratedText({ text, tools: [] });
    const tool = out.find((x) => x.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(JSON.parse(tool.input).content).toBe("line1\r\nline2");
  });

  it("handles multiple control characters in one value", () => {
    const p = hermesProtocol();
    const text = `<tool_call>{"name":"edit","arguments":{"content":"a\nb\tc\rd"}}</tool_call>`;
    const out = p.parseGeneratedText({ text, tools: [] });
    const tool = out.find((x) => x.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(JSON.parse(tool.input).content).toBe("a\nb\tc\rd");
  });

  it("does not double-escape already-escaped sequences", () => {
    const p = hermesProtocol();
    // The \\n in the template literal produces a literal backslash + n in the JSON,
    // which is a valid JSON escape for a newline character.
    const text = `<tool_call>{"name":"edit","arguments":{"content":"line1\\nline2"}}</tool_call>`;
    const out = p.parseGeneratedText({ text, tools: [] });
    const tool = out.find((x) => x.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    // \\n in JSON source decodes to a newline character
    expect(JSON.parse(tool.input).content).toBe("line1\nline2");
  });

  it("preserves structural whitespace outside strings", () => {
    const p = hermesProtocol();
    const text = `<tool_call>{\n  "name": "bash",\n  "arguments": {\n    "command": "ls"\n  }\n}</tool_call>`;
    const out = p.parseGeneratedText({ text, tools: [] });
    const tool = out.find((x) => x.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(tool.toolName).toBe("bash");
    expect(JSON.parse(tool.input).command).toBe("ls");
  });
});
