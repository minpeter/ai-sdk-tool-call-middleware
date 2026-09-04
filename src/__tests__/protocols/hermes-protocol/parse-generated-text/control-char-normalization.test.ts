import type { JSONObject } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

interface NormalizationCase {
  readonly expectedContent?: string;
  readonly expectedInput?: JSONObject;
  readonly expectedToolName?: string;
  readonly name: string;
  readonly text: string;
}

const cases: readonly NormalizationCase[] = [
  {
    name: "parses tool call with raw newline in argument value",
    text: `<tool_call>{"name":"edit","arguments":{"content":"line1
line2"}}</tool_call>`,
    expectedToolName: "edit",
    expectedContent: "line1\nline2",
  },
  {
    name: "parses tool call with raw tab in argument value",
    text: `<tool_call>{"name":"edit","arguments":{"content":"col1\tcol2"}}</tool_call>`,
    expectedContent: "col1\tcol2",
  },
  {
    name: "parses tool call with raw carriage return in argument value",
    text: `<tool_call>{"name":"edit","arguments":{"content":"line1\r
line2"}}</tool_call>`,
    expectedContent: "line1\r\nline2",
  },
  {
    name: "handles multiple control characters in one value",
    text: `<tool_call>{"name":"edit","arguments":{"content":"a
b\tc\rd"}}</tool_call>`,
    expectedContent: "a\nb\tc\rd",
  },
  {
    name: "does not double-escape already-escaped sequences",
    text: `<tool_call>{"name":"edit","arguments":{"content":"line1\\nline2"}}</tool_call>`,
    expectedContent: "line1\nline2",
  },
  {
    name: "preserves structural whitespace outside strings",
    text: `<tool_call>{
  "name": "bash",
  "arguments": {
    "command": "ls"
  }
}</tool_call>`,
    expectedToolName: "bash",
    expectedInput: { command: "ls" },
  },
  {
    name: "handles escaped quote followed by raw newline",
    text: `<tool_call>{"name":"edit","arguments":{"content":"say \\"hello\\"
there"}}</tool_call>`,
    expectedContent: 'say "hello"\nthere',
  },
  {
    name: "handles double backslash followed by raw newline (not an escape)",
    text: `<tool_call>{"name":"edit","arguments":{"content":"path\\\\\\\\
line2"}}</tool_call>`,
    expectedContent: "path\\\\\nline2",
  },
  {
    name: "handles backslash followed by raw newline",
    text: `<tool_call>${'{"name":"edit","arguments":{"content":"foo\\\nbar"}}'}</tool_call>`,
    expectedToolName: "edit",
    expectedContent: "foo\nbar",
  },
  {
    name: "handles backslash followed by raw tab",
    text: `<tool_call>${'{"name":"edit","arguments":{"content":"foo\\\tbar"}}'}</tool_call>`,
    expectedContent: "foo\tbar",
  },
  {
    name: "handles triple backslash before quote (escaped backslash + escaped quote)",
    text: `<tool_call>{"name":"edit","arguments":{"content":"a\\\\\\"b"}}</tool_call>`,
    expectedContent: 'a\\"b',
  },
  {
    name: "preserves relaxed single-quoted strings containing double quotes",
    text: `<tool_call>{
  name: 'echo "hi"',
  arguments: {}
}</tool_call>`,
    expectedToolName: 'echo "hi"',
    expectedInput: {},
  },
  {
    name: "normalizes raw control characters inside relaxed single-quoted strings",
    text: `<tool_call>{name:'edit',arguments:{content:'line1
line2'}}</tool_call>`,
    expectedContent: "line1\nline2",
  },
  {
    name: "does not treat apostrophes in relaxed line comments as strings",
    text: `<tool_call>{
  name: "edit",
  arguments: {}, // it's a comment
  extra: 1
}</tool_call>`,
    expectedToolName: "edit",
  },
  {
    name: "skips relaxed comments in slow-path normalization",
    text: `<tool_call>{
  name: "edit",
  arguments: {
    content: "line1
line2"
  }, // it's a comment
  extra: 1
}</tool_call>`,
    expectedContent: "line1\nline2",
  },
  {
    name: "treats carriage returns as relaxed line-comment terminators",
    text: '<tool_call>{name:"edit", // it\'s comment\rarguments:{content:"line1\rline2"}}</tool_call>',
    expectedContent: "line1\rline2",
  },
];

describe("parseGeneratedText control character normalization", () => {
  const protocol = hermesProtocol();

  for (const testCase of cases) {
    it(testCase.name, () => {
      const out = protocol.parseGeneratedText({
        text: testCase.text,
        tools: [],
      });
      const tool = out.find((part) => part.type === "tool-call");
      expect(tool).toBeTruthy();
      if (tool?.type !== "tool-call") {
        throw new TypeError("Expected a tool-call part");
      }
      if (testCase.expectedToolName !== undefined) {
        expect(tool.toolName).toBe(testCase.expectedToolName);
      }
      const input = JSON.parse(tool.input);
      if (testCase.expectedContent !== undefined) {
        expect(input.content).toBe(testCase.expectedContent);
      }
      if (testCase.expectedInput !== undefined) {
        expect(input).toEqual(testCase.expectedInput);
      }
    });
  }
});
