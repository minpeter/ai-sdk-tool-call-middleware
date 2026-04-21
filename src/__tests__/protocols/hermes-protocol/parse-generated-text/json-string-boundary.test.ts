import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

describe("parseGeneratedText – end tag inside JSON string values", () => {
  it("does not split on </tool_call> inside a JSON string value", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"bash","arguments":{"command":"echo \'</tool_call>\' test"}}</tool_call>';
    const out = p.parseGeneratedText({ text, tools: [] });

    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("tool-call");
    const tc = out[0] as any;
    expect(tc.toolName).toBe("bash");
    expect(JSON.parse(tc.input)).toEqual({
      command: "echo '</tool_call>' test",
    });
  });

  it("handles multiple tool calls where one contains end tag in string value", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"a","arguments":{}}</tool_call>' +
      " middle " +
      '<tool_call>{"name":"bash","arguments":{"cmd":"</tool_call>"}}</tool_call>' +
      " end";
    const out = p.parseGeneratedText({ text, tools: [] });

    const toolCalls = out.filter((e) => e.type === "tool-call") as any[];
    const textParts = out
      .filter((e) => e.type === "text")
      .map((e) => (e as any).text);

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].toolName).toBe("a");
    expect(toolCalls[1].toolName).toBe("bash");
    expect(JSON.parse(toolCalls[1].input)).toEqual({ cmd: "</tool_call>" });
    expect(textParts.join("")).toContain("middle");
    expect(textParts.join("")).toContain("end");
  });

  it("still parses normal tool calls correctly (regression check)", () => {
    const p = hermesProtocol();
    const text =
      'before <tool_call>{"name":"get_weather","arguments":{"city":"NYC"}}</tool_call> after';
    const out = p.parseGeneratedText({ text, tools: [] });

    const toolCalls = out.filter((e) => e.type === "tool-call") as any[];
    const textParts = out
      .filter((e) => e.type === "text")
      .map((e) => (e as any).text);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].toolName).toBe("get_weather");
    expect(JSON.parse(toolCalls[0].input)).toEqual({ city: "NYC" });
    expect(textParts.join("")).toContain("before");
    expect(textParts.join("")).toContain("after");
  });

  it("handles escaped quotes adjacent to end tag in string value", () => {
    const p = hermesProtocol();
    // The argument value is: say \"</tool_call>\" ok
    const text =
      '<tool_call>{"name":"bash","arguments":{"cmd":"say \\"</tool_call>\\" ok"}}</tool_call>';
    const out = p.parseGeneratedText({ text, tools: [] });

    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("tool-call");
    const tc = out[0] as any;
    expect(tc.toolName).toBe("bash");
    const parsed = JSON.parse(tc.input);
    expect(parsed.cmd).toBe('say "</tool_call>" ok');
  });

  it("handles multiple false end tags in one string value", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"bash","arguments":{"cmd":"first </tool_call> and second </tool_call> end"}}</tool_call>';
    const out = p.parseGeneratedText({ text, tools: [] });

    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("tool-call");
    const tc = out[0] as any;
    expect(tc.toolName).toBe("bash");
    const parsed = JSON.parse(tc.input);
    expect(parsed.cmd).toBe("first </tool_call> and second </tool_call> end");
  });
});

describe("parseGeneratedText – relaxed JSON comments around tool-call tags", () => {
  it("ignores </tool_call> and quotes inside relaxed line comments", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{name:"line_comment",arguments:{}, // " </tool_call> inside comment\n}</tool_call>';
    const out = p.parseGeneratedText({ text, tools: [] });

    const tool = out.find((x) => x.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(tool.toolName).toBe("line_comment");
    expect(JSON.parse(tool.input)).toEqual({});
  });

  it("ignores <tool_call> nested-start text inside relaxed block comments", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{name:"block_comment",arguments:{}, /* ignored <tool_call> text */}</tool_call>';
    const out = p.parseGeneratedText({ text, tools: [] });

    const tool = out.find((x) => x.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(tool.toolName).toBe("block_comment");
    expect(JSON.parse(tool.input)).toEqual({});
  });
});

it("does not treat // inside a relaxed unquoted identifier as a comment", () => {
  const p = hermesProtocol();
  const text = '<tool_call>{name:"x",arguments:{path:a//b}}</tool_call>';
  const out = p.parseGeneratedText({ text, tools: [] });

  const tool = out.find((x) => x.type === "tool-call") as any;
  expect(tool).toBeTruthy();
  expect(tool.toolName).toBe("x");
  expect(JSON.parse(tool.input)).toEqual({ path: "a//b" });
});

it("still treats // after a relaxed number literal as a comment", () => {
  const p = hermesProtocol();
  const text =
    '<tool_call>{name:"x",arguments:{n:1// " </tool_call> inside comment\n}}</tool_call>';
  const out = p.parseGeneratedText({ text, tools: [] });

  const tool = out.find((x) => x.type === "tool-call") as any;
  expect(tool).toBeTruthy();
  expect(tool.toolName).toBe("x");
  expect(JSON.parse(tool.input)).toEqual({ n: 1 });
});

describe("parseGeneratedText – malformed tool call recovery", () => {
  it("recovers from malformed tool call with embedded end tag but no real closing tag", () => {
    const p = hermesProtocol();
    // First tool call has </tool_call> inside the string but no real closing tag
    // Second tool call is valid
    const text =
      '<tool_call>{"name":"bash","arguments":{"cmd":"x </tool_call> y"}} ' +
      '<tool_call>{"name":"ok","arguments":{}}</tool_call>';
    const out = p.parseGeneratedText({ text, tools: [] });
    const tools = out.filter((x) => x.type === "tool-call") as any[];
    // The valid second tool call should be parsed
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools.some((t: any) => t.toolName === "ok")).toBe(true);
  });

  it("does not emit text twice for malformed tool call with no real closing tag", () => {
    const p = hermesProtocol();
    const text =
      'prefix <tool_call>{"name":"bash","arguments":{"cmd":"x </tool_call> y"}} suffix';
    const out = p.parseGeneratedText({ text, tools: [] });
    const allText = out
      .filter((x) => x.type === "text")
      .map((x) => (x as any).text)
      .join("");
    // "prefix" should appear exactly once
    const prefixCount = (allText.match(/prefix/g) || []).length;
    expect(prefixCount).toBe(1);
  });
});

it("recovers a valid adjacent tool call after a malformed one without whitespace", () => {
  const p = hermesProtocol();
  const text =
    '<tool_call>{"name":"bash","arguments":{"cmd":"x </tool_call> y"}}' +
    '<tool_call>{"name":"ok","arguments":{}}</tool_call>';
  const out = p.parseGeneratedText({ text, tools: [] });
  const tools = out.filter((x) => x.type === "tool-call") as any[];
  expect(tools.map((tool) => tool.toolName)).toEqual(["ok"]);
});

describe("extractToolCallSegments – end tag inside JSON string values", () => {
  it("skips end tag embedded in a JSON string value", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"bash","arguments":{"command":"echo \'</tool_call>\' test"}}</tool_call>';
    if (!p.extractToolCallSegments) {
      throw new Error("extractToolCallSegments is not defined");
    }
    const segments = p.extractToolCallSegments({ text, tools: [] });

    expect(segments).toHaveLength(1);
    expect(segments[0]).toBe(text);
  });

  it("extracts multiple segments with embedded end tags correctly", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"a","arguments":{}}</tool_call>' +
      " middle " +
      '<tool_call>{"name":"bash","arguments":{"cmd":"</tool_call>"}}</tool_call>';
    if (!p.extractToolCallSegments) {
      throw new Error("extractToolCallSegments is not defined");
    }
    const segments = p.extractToolCallSegments({ text, tools: [] });

    expect(segments).toHaveLength(2);
    expect(segments[0]).toBe(
      '<tool_call>{"name":"a","arguments":{}}</tool_call>'
    );
    expect(segments[1]).toBe(
      '<tool_call>{"name":"bash","arguments":{"cmd":"</tool_call>"}}</tool_call>'
    );
  });

  it("does not treat <tool_call> inside a JSON string as a nested start tag", () => {
    const p = hermesProtocol();
    // The argument value contains a literal <tool_call> tag inside a string.
    // This should NOT cause the parser to think a nested tool call exists.
    const text =
      '<tool_call>{"name":"bash","arguments":{"cmd":"echo <tool_call> test"}}</tool_call>';
    const out = p.parseGeneratedText({ text, tools: [] });
    const tool = out.find((x) => x.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(tool.toolName).toBe("bash");
    expect(JSON.parse(tool.input).cmd).toBe("echo <tool_call> test");
  });

  it("ignores relaxed comments while extracting tool-call segments", () => {
    const p = hermesProtocol();
    if (!p.extractToolCallSegments) {
      throw new Error("extractToolCallSegments is not defined");
    }

    const lineComment =
      '<tool_call>{name:"line_comment",arguments:{}, // " </tool_call> inside comment\n}</tool_call>';
    const blockComment =
      '<tool_call>{name:"block_comment",arguments:{}, /* ignored <tool_call> text */}</tool_call>';

    const segments = p.extractToolCallSegments({
      text: `${lineComment} between ${blockComment}`,
      tools: [],
    });

    expect(segments).toEqual([lineComment, blockComment]);
  });
});
