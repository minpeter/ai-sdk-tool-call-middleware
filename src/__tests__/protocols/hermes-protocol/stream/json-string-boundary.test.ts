import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import { extractStreamingToolCallProgress } from "../../../../core/protocols/hermes-streaming-progress";
import {
  collectTextDeltas,
  parseToolCallObject,
  requireToolCall,
  runProtocolTextStream,
  selectToolCalls,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

const protocol = hermesProtocol();

function runHermes(chunks: readonly string[]) {
  return runProtocolTextStream({
    chunks,
    id: "1",
    protocol,
    tools: [],
  });
}

const boundaryCases = [
  {
    name: "does not split on </tool_call> inside a JSON string value (single chunk)",
    chunks: [
      '<tool_call>{"name":"bash","arguments":{"command":"echo \'</tool_call>\' test"}}</tool_call>',
    ],
    toolName: "bash",
    input: { command: "echo '</tool_call>' test" },
  },
  {
    name: "does not split on </tool_call> inside a JSON string value split across chunks",
    chunks: [
      '<tool_call>{"name":"bash","arguments":{"command":"echo \'',
      "</tool_call>",
      "' test\"}}</tool_call>",
    ],
    toolName: "bash",
    input: { command: "echo '</tool_call>' test" },
  },
  {
    name: "handles chunk split in the middle of an escape sequence",
    chunks: [
      '<tool_call>{"name":"bash","arguments":{"cmd":"say \\',
      '"</tool_call>\\',
      '" ok"}}</tool_call>',
    ],
    toolName: "bash",
    input: { cmd: 'say "</tool_call>" ok' },
  },
  {
    name: "handles multiple false end tags in one string value (streaming)",
    chunks: [
      '<tool_call>{"name":"bash","arguments":{"cmd":"first </tool_call>',
      ' and second </tool_call> end"}}</tool_call>',
    ],
    toolName: "bash",
    input: { cmd: "first </tool_call> and second </tool_call> end" },
  },
  {
    name: "does not treat // inside a relaxed unquoted identifier as a comment",
    chunks: ['<tool_call>{name:"x",arguments:{path:a//b}}</tool_call>'],
    toolName: "x",
    input: { path: "a//b" },
  },
  {
    name: "ignores </tool_call> and quotes inside relaxed line comments",
    chunks: [
      '<tool_call>{name:"line_comment",arguments:{}, // " </tool_call> inside comment\n}</tool_call>',
    ],
    toolName: "line_comment",
    input: {},
  },
  {
    name: "ignores </tool_call> inside a relaxed block comment split across chunks",
    chunks: [
      '<tool_call>{name:"block_comment",arguments:{}, /* " </tool_',
      "call> inside comment */}</tool_call>",
    ],
    toolName: "block_comment",
    input: {},
  },
] as const;

describe("hermesProtocol streaming – end tag inside JSON string values", () => {
  it("keeps escaped quotes inside a quoted arguments value", () => {
    const toolCallJson =
      '{"name":"echo","arguments":"{\\"value\\":\\"quoted\\"}"}';

    const progress = extractStreamingToolCallProgress(toolCallJson);

    expect(progress).toEqual({
      toolName: "echo",
      argumentsText: '"{\\"value\\":\\"quoted\\"}"',
      argumentsComplete: true,
    });
  });

  for (const testCase of boundaryCases) {
    it(testCase.name, async () => {
      const out = await runHermes(testCase.chunks);
      const tool = requireToolCall(out);

      expect(tool).toBeTruthy();
      expect(tool.toolName).toBe(testCase.toolName);
      expect(parseToolCallObject(tool)).toEqual(testCase.input);
      if (testCase.name.includes("single chunk")) {
        const text = collectTextDeltas(out);
        expect(text).not.toContain("<tool_call>");
        expect(text).not.toContain("</tool_call>");
      }
    });
  }

  it("still parses normal streaming tool calls correctly (regression check)", async () => {
    const out = await runHermes([
      "before ",
      '<tool_call>{"name":"get_weather","arguments":{"city":"NYC"}}</tool_call>',
      " after",
    ]);
    const tool = requireToolCall(out);
    const text = collectTextDeltas(out);

    expect(tool).toBeTruthy();
    expect(tool.toolName).toBe("get_weather");
    expect(parseToolCallObject(tool)).toEqual({ city: "NYC" });
    expect(text).toContain("before");
    expect(text).toContain("after");
    expect(text).not.toContain("<tool_call>");
    expect(text).not.toContain("</tool_call>");
  });

  it("parses adjacent tool calls when the first contains </tool_call> inside its JSON string value", async () => {
    const out = await runHermes([
      '<tool_call>{"name":"bash","arguments":{"cmd":"x </tool_call> y"}}</tool_call>' +
        '<tool_call>{"name":"ok","arguments":{}}</tool_call>',
    ]);

    expect(out.some((part) => part.type === "finish")).toBe(true);
    expect(out.filter((part) => part.type === "finish").length).toBe(1);
    const { starts } = selectToolInputTimeline(out);
    expect(starts[0]).toBeDefined();
    expect(starts[0].toolName).toBe("bash");
    const toolCalls = selectToolCalls(out);
    expect(toolCalls.map((call) => call.toolName)).toEqual(["bash", "ok"]);
    expect(parseToolCallObject(toolCalls[0])).toEqual({
      cmd: "x </tool_call> y",
    });
    expect(parseToolCallObject(toolCalls[1])).toEqual({});
  });

  it("parses a second <tool_call> that follows a fully closed first one in the same chunk", async () => {
    const out = await runHermes([
      '<tool_call>{"name":"bash","arguments":{"cmd":"x </tool_call> y"}}</tool_call>' +
        '<tool_call>{"name":"ok","arguments":{}}</tool_call>',
    ]);

    expect(selectToolCalls(out).map((call) => call.toolName)).toEqual([
      "bash",
      "ok",
    ]);
  });

  it("does not treat an unquoted RJSON key matching a custom start delimiter as nested in streams", async () => {
    const customProtocol = hermesProtocol({
      toolCallStart: "name",
      toolCallEnd: "END",
    });
    const out = await runProtocolTextStream({
      chunks: ['name{name:"ok",arguments:{}}END'],
      id: "1",
      protocol: customProtocol,
      tools: [],
    });
    const toolCall = requireToolCall(out);

    expect(toolCall).toBeTruthy();
    expect(toolCall.toolName).toBe("ok");
    expect(parseToolCallObject(toolCall)).toEqual({});
  });
});
