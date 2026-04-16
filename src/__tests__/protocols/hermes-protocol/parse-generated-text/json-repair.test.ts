import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

function makeTool(
  name: string,
  properties: Record<string, { type: string }>
): LanguageModelV3FunctionTool {
  return {
    type: "function",
    name,
    inputSchema: {
      type: "object",
      properties,
    },
  };
}

describe("parseGeneratedText JSON repair", () => {
  it("repairs unescaped quotes in a string value", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"edit","arguments":{"content":"He said "hello" to me"}}</tool_call>';
    const out = p.parseGeneratedText({ text, tools: [] });
    const tool = out.find((x) => x.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(tool.toolName).toBe("edit");
    const args = JSON.parse(tool.input);
    expect(args.content).toBe('He said "hello" to me');
  });

  it("repairs multiple arguments with one having unescaped quotes", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"path":"/tmp/a.txt","content":"use "strict"; var x = 1;"}}</tool_call>';
    const tools = [makeTool("write", { path: { type: "string" }, content: { type: "string" } })];
    const out = p.parseGeneratedText({ text, tools });
    const tool = out.find((x) => x.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(tool.toolName).toBe("write");
    const args = JSON.parse(tool.input);
    expect(args.path).toBe("/tmp/a.txt");
    expect(args.content).toContain('"strict"');
  });

  it("uses known arg keys to filter false-positive key matches", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"edit","arguments":{"content":"value with ,"fake": inside"}}</tool_call>';
    const tools = [makeTool("edit", { content: { type: "string" } })];
    const out = p.parseGeneratedText({ text, tools });
    const tool = out.find((x) => x.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(tool.toolName).toBe("edit");
    const args = JSON.parse(tool.input);
    expect(args.content).toContain("fake");
  });

  it("does not alter already valid JSON", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"read","arguments":{"path":"/tmp/file.txt"}}</tool_call>';
    const out = p.parseGeneratedText({ text, tools: [] });
    const tool = out.find((x) => x.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(tool.toolName).toBe("read");
    expect(JSON.parse(tool.input)).toEqual({ path: "/tmp/file.txt" });
  });

  it("falls through to error for completely broken JSON (no name field)", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text = "<tool_call>{totally broken}</tool_call>";
    const out = p.parseGeneratedText({ text, tools: [], options: { onError } });
    expect(onError).toHaveBeenCalled();
    const rejoined = out
      .map((x) => (x.type === "text" ? (x as any).text : ""))
      .join("");
    expect(rejoined).toContain("{totally broken}");
  });

  it("repairs alongside numeric and boolean arguments", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"update","arguments":{"content":"He said "hi" there","count":42,"enabled":true}}</tool_call>';
    const tools = [
      makeTool("update", {
        content: { type: "string" },
        count: { type: "number" },
        enabled: { type: "boolean" },
      }),
    ];
    const out = p.parseGeneratedText({ text, tools });
    const tool = out.find((x) => x.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(tool.toolName).toBe("update");
    const args = JSON.parse(tool.input);
    expect(args.content).toBe('He said "hi" there');
    expect(args.count).toBe(42);
    expect(args.enabled).toBe(true);
  });
});
