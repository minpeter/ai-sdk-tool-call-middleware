import { describe, expect, it } from "vitest";

import { jsonProtocol } from "../../core/protocols/json-protocol";

describe("jsonProtocol formatters and parseGeneratedText edges", () => {
  it("formatToolCall stringifies input JSON and non-JSON inputs", () => {
    const p = jsonProtocol();
    const xml = p.formatToolCall({
      type: "tool-call",
      toolCallId: "id",
      toolName: "run",
      input: '{"a":1}',
    } as any);
    expect(xml).toContain("<tool_call>");
    const xml2 = p.formatToolCall({
      type: "tool-call",
      toolCallId: "id",
      toolName: "run",
      input: "not-json" as any,
    } as any);
    expect(xml2).toContain("run");
  });

  it("parseGeneratedText falls back to text on malformed tool call", () => {
    const p = jsonProtocol();
    const out = p.parseGeneratedText({
      text: "prefix <tool_call>{bad}</tool_call> suffix",
      tools: [],
    });
    const combined = out
      .map((c: any) => (c.type === "text" ? c.text : ""))
      .join("");
    expect(combined).toContain("<tool_call>{bad}</tool_call>");
  });

  it("recovers unclosed tool_call when JSON envelope is complete", () => {
    const p = jsonProtocol();
    const out = p.parseGeneratedText({
      text: 'prefix <tool_call>{"name":"get_weather","arguments":{"city":"Seoul","unit":"celsius"}}',
      tools: [],
    });
    const tool = out.find((c) => c.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(tool.toolName).toBe("get_weather");
    expect(JSON.parse(tool.input)).toEqual({
      city: "Seoul",
      unit: "celsius",
    });
    const combinedText = out
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("");
    expect(combinedText).toContain("prefix ");
  });

  it("does not recover unclosed tool_call when trailing non-tag text exists", () => {
    const p = jsonProtocol();
    const source = '<tool_call>{"name":"x","arguments":{}} trailing text';
    const out = p.parseGeneratedText({
      text: source,
      tools: [],
    });
    expect(out.some((c) => c.type === "tool-call")).toBe(false);
    const combinedText = out
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("");
    expect(combinedText).toContain(source);
  });

  it("does not recover unclosed tool_call when JSON is malformed", () => {
    const p = jsonProtocol();
    const source = '<tool_call>{"name":"x","arguments":';
    const out = p.parseGeneratedText({
      text: source,
      tools: [],
    });
    expect(out.some((c) => c.type === "tool-call")).toBe(false);
    const combinedText = out
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("");
    expect(combinedText).toContain(source);
  });
});
