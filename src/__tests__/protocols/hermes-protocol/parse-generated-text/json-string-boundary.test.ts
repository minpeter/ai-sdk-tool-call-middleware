import type { LanguageModelV4Content } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";

const protocol = hermesProtocol();

type ToolCall = Extract<LanguageModelV4Content, { type: "tool-call" }>;

function parse(text: string): LanguageModelV4Content[] {
  return protocol.parseGeneratedText({ text, tools: [] });
}

function requireToolCall(out: readonly LanguageModelV4Content[]): ToolCall {
  const tool = out.find((part): part is ToolCall => part.type === "tool-call");
  expect(tool).toBeTruthy();
  if (tool === undefined) {
    throw new TypeError("Expected a tool-call part");
  }
  return tool;
}

function expectSingleToolCall(
  out: readonly LanguageModelV4Content[]
): ToolCall {
  expect(out).toHaveLength(1);
  expect(out[0]?.type).toBe("tool-call");
  return requireToolCall(out);
}

function selectCallsAndText(out: readonly LanguageModelV4Content[]) {
  return {
    toolCalls: out.filter((part) => part.type === "tool-call"),
    textParts: out
      .filter((part) => part.type === "text")
      .map((part) => part.text),
  };
}

function extractSegments(text: string): string[] {
  if (!protocol.extractToolCallSegments) {
    throw new Error("extractToolCallSegments is not defined");
  }
  return protocol.extractToolCallSegments({ text, tools: [] });
}

describe("parseGeneratedText – end tag inside JSON string values", () => {
  it("does not split on </tool_call> inside a JSON string value", () => {
    const out = parse(
      '<tool_call>{"name":"bash","arguments":{"command":"echo \'</tool_call>\' test"}}</tool_call>'
    );
    const tool = expectSingleToolCall(out);
    expect(tool.toolName).toBe("bash");
    expect(JSON.parse(tool.input)).toEqual({
      command: "echo '</tool_call>' test",
    });
  });

  it("handles multiple tool calls where one contains end tag in string value", () => {
    const out = parse(
      '<tool_call>{"name":"a","arguments":{}}</tool_call>' +
        " middle " +
        '<tool_call>{"name":"bash","arguments":{"cmd":"</tool_call>"}}</tool_call>' +
        " end"
    );
    const { toolCalls, textParts } = selectCallsAndText(out);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]?.toolName).toBe("a");
    expect(toolCalls[1]?.toolName).toBe("bash");
    expect(JSON.parse(toolCalls[1]?.input ?? "{}")).toEqual({
      cmd: "</tool_call>",
    });
    expect(textParts.join("")).toContain("middle");
    expect(textParts.join("")).toContain("end");
  });

  it("still parses normal tool calls correctly (regression check)", () => {
    const out = parse(
      'before <tool_call>{"name":"get_weather","arguments":{"city":"NYC"}}</tool_call> after'
    );
    const { toolCalls, textParts } = selectCallsAndText(out);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.toolName).toBe("get_weather");
    expect(JSON.parse(toolCalls[0]?.input ?? "{}")).toEqual({ city: "NYC" });
    expect(textParts.join("")).toContain("before");
    expect(textParts.join("")).toContain("after");
  });

  const embeddedEndTagCases = [
    {
      name: "handles escaped quotes adjacent to end tag in string value",
      text: '<tool_call>{"name":"bash","arguments":{"cmd":"say \\"</tool_call>\\" ok"}}</tool_call>',
      expected: 'say "</tool_call>" ok',
    },
    {
      name: "handles multiple false end tags in one string value",
      text: '<tool_call>{"name":"bash","arguments":{"cmd":"first </tool_call> and second </tool_call> end"}}</tool_call>',
      expected: "first </tool_call> and second </tool_call> end",
    },
  ];

  for (const testCase of embeddedEndTagCases) {
    it(testCase.name, () => {
      const out = parse(testCase.text);
      const tool = expectSingleToolCall(out);
      expect(tool.toolName).toBe("bash");
      expect(JSON.parse(tool.input).cmd).toBe(testCase.expected);
    });
  }
});

describe("parseGeneratedText – relaxed JSON comments around tool-call tags", () => {
  const commentCases = [
    {
      name: "ignores </tool_call> and quotes inside relaxed line comments",
      text: '<tool_call>{name:"line_comment",arguments:{}, // " </tool_call> inside comment\n}</tool_call>',
      toolName: "line_comment",
    },
    {
      name: "ignores <tool_call> nested-start text inside relaxed block comments",
      text: '<tool_call>{name:"block_comment",arguments:{}, /* ignored <tool_call> text */}</tool_call>',
      toolName: "block_comment",
    },
  ];

  for (const testCase of commentCases) {
    it(testCase.name, () => {
      const tool = requireToolCall(parse(testCase.text));
      expect(tool.toolName).toBe(testCase.toolName);
      expect(JSON.parse(tool.input)).toEqual({});
    });
  }
});

it("does not treat // inside a relaxed unquoted identifier as a comment", () => {
  const tool = requireToolCall(
    parse('<tool_call>{name:"x",arguments:{path:a//b}}</tool_call>')
  );
  expect(tool.toolName).toBe("x");
  expect(JSON.parse(tool.input)).toEqual({ path: "a//b" });
});

it("does not treat // inside a quoted string as a comment boundary for the next key", () => {
  const tool = requireToolCall(
    parse(
      '<tool_call>{name:"x",arguments:{url:"https://example.com/a//b",next:1}}</tool_call>'
    )
  );
  expect(tool.toolName).toBe("x");
  expect(JSON.parse(tool.input)).toEqual({
    url: "https://example.com/a//b",
    next: 1,
  });
});

it("still treats // after a relaxed number literal as a comment", () => {
  const tool = requireToolCall(
    parse(
      '<tool_call>{name:"x",arguments:{n:1// " </tool_call> inside comment\n}}</tool_call>'
    )
  );
  expect(tool.toolName).toBe("x");
  expect(JSON.parse(tool.input)).toEqual({ n: 1 });
});

describe("parseGeneratedText – malformed tool call recovery", () => {
  it("recovers from malformed tool call with embedded end tag but no real closing tag", () => {
    const out = parse(
      '<tool_call>{"name":"bash","arguments":{"cmd":"x </tool_call> y"}} ' +
        '<tool_call>{"name":"ok","arguments":{}}</tool_call>'
    );
    const tools = out.filter((part) => part.type === "tool-call");
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools.some((tool) => tool.toolName === "ok")).toBe(true);
  });

  it("does not emit text twice for malformed tool call with no real closing tag", () => {
    const out = parse(
      'prefix <tool_call>{"name":"bash","arguments":{"cmd":"x </tool_call> y"}} suffix'
    );
    const allText = out
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    const prefixCount = (allText.match(/prefix/g) || []).length;
    expect(prefixCount).toBe(1);
  });
});

it("recovers a valid adjacent tool call after a malformed one without whitespace", () => {
  const out = parse(
    '<tool_call>{"name":"bash","arguments":{"cmd":"x </tool_call> y"}}' +
      '<tool_call>{"name":"ok","arguments":{}}</tool_call>'
  );
  const tools = out.filter((part) => part.type === "tool-call");
  expect(tools.map((tool) => tool.toolName)).toEqual(["ok"]);
});

describe("extractToolCallSegments – end tag inside JSON string values", () => {
  it("skips end tag embedded in a JSON string value", () => {
    const text =
      '<tool_call>{"name":"bash","arguments":{"command":"echo \'</tool_call>\' test"}}</tool_call>';
    const segments = extractSegments(text);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toBe(text);
  });

  it("extracts multiple segments with embedded end tags correctly", () => {
    const segments = extractSegments(
      '<tool_call>{"name":"a","arguments":{}}</tool_call>' +
        " middle " +
        '<tool_call>{"name":"bash","arguments":{"cmd":"</tool_call>"}}</tool_call>'
    );
    expect(segments).toHaveLength(2);
    expect(segments[0]).toBe(
      '<tool_call>{"name":"a","arguments":{}}</tool_call>'
    );
    expect(segments[1]).toBe(
      '<tool_call>{"name":"bash","arguments":{"cmd":"</tool_call>"}}</tool_call>'
    );
  });

  it("does not treat <tool_call> inside a JSON string as a nested start tag", () => {
    const tool = requireToolCall(
      parse(
        '<tool_call>{"name":"bash","arguments":{"cmd":"echo <tool_call> test"}}</tool_call>'
      )
    );
    expect(tool.toolName).toBe("bash");
    expect(JSON.parse(tool.input).cmd).toBe("echo <tool_call> test");
  });

  it("ignores relaxed comments while extracting tool-call segments", () => {
    const lineComment =
      '<tool_call>{name:"line_comment",arguments:{}, // " </tool_call> inside comment\n}</tool_call>';
    const blockComment =
      '<tool_call>{name:"block_comment",arguments:{}, /* ignored <tool_call> text */}</tool_call>';
    const segments = extractSegments(`${lineComment} between ${blockComment}`);
    expect(segments).toEqual([lineComment, blockComment]);
  });
});
