import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import type {
  ParserOptions,
  TCMProtocol,
} from "../../../../core/protocols/protocol-interface";
import {
  collectTextDeltas,
  parseToolCallObject,
  requireToolCall,
  runProtocolTextStream,
  selectToolCalls,
} from "../../shared/duplicate-harness";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

type OnError = NonNullable<ParserOptions["onError"]>;

function runHermes(
  chunks: readonly string[],
  protocol: Pick<TCMProtocol, "createStreamParser"> = hermesProtocol(),
  parserOptions?: ParserOptions
) {
  return runProtocolTextStream({
    chunks,
    id: "1",
    parserOptions,
    protocol,
    tools: [],
  });
}

const customDelimiterCases = [
  {
    name: "does not treat a nested RJSON property matching a custom start delimiter as nested in streams",
    text: 'name:{name:"ok",arguments:{name:{a:1}}}END',
    input: { name: { a: 1 } },
  },
  {
    name: "does not treat comma-delimited RJSON properties matching a custom delimiter as nested in streams",
    text: 'name:{name:"ok",arguments:{x:1,name:{a:1}}}END',
    input: { x: 1, name: { a: 1 } },
  },
  {
    name: "does not treat spaced RJSON properties matching a custom delimiter as nested in streams",
    text: 'name:{name:"ok",arguments:{x:1, name:{a:1}}}END',
    input: { x: 1, name: { a: 1 } },
  },
] as const;

const malformedRecoveryCases = [
  {
    name: "recovers a valid tool call after an unterminated relaxed line comment consumes an end tag",
    malformed: '<tool_call>{name:"bad",arguments:{n:1//x}}</tool_call>',
  },
  {
    name: "recovers a valid tool call after an unterminated relaxed block comment consumes an end tag",
    malformed: '<tool_call>{name:"bad",arguments:{n:1/*x}}</tool_call>',
  },
  {
    name: "recovers a valid adjacent tool call after a malformed one without whitespace",
    malformed:
      '<tool_call>{"name":"bash","arguments":{"cmd":"x </tool_call> y"}}',
  },
] as const;

const VALID_OK_CALL = '<tool_call>{"name":"ok","arguments":{}}</tool_call>';

describe("hermesProtocol streaming – comments and malformed recovery", () => {
  it("still treats // after a relaxed number literal as a comment", async () => {
    const out = await runHermes([
      '<tool_call>{name:"x",arguments:{n:1// " </tool_call> inside comment\n}}</tool_call>',
    ]);
    const tool = requireToolCall(out);

    expect(tool).toBeTruthy();
    expect(tool.toolName).toBe("x");
    expect(parseToolCallObject(tool)).toEqual({ n: 1 });
  });

  for (const testCase of customDelimiterCases) {
    it(testCase.name, async () => {
      const protocol = hermesProtocol({
        toolCallStart: "name:",
        toolCallEnd: "END",
      });
      const out = await runHermes([testCase.text], protocol);
      const toolCall = requireToolCall(out);

      expect(toolCall).toBeTruthy();
      expect(toolCall.toolName).toBe("ok");
      expect(parseToolCallObject(toolCall)).toEqual(testCase.input);
    });
  }

  for (const testCase of malformedRecoveryCases) {
    it(testCase.name, async () => {
      const out = await runHermes([testCase.malformed + VALID_OK_CALL]);

      expect(selectToolCalls(out).map((call) => call.toolName)).toEqual(["ok"]);
    });
  }

  it("reports and optionally emits raw text when recovering after a malformed nested start", async () => {
    const onError = vi.fn<OnError>();
    const malformedPrefix =
      '<tool_call>{"name":"bash","arguments":{"cmd":"x </tool_call> y"}} ';
    const out = await runHermes(
      [`${malformedPrefix}${VALID_OK_CALL}`],
      hermesProtocol(),
      { onError, emitRawToolCallTextOnError: true }
    );

    expect(collectTextDeltas(out)).toContain(malformedPrefix);
    expect(selectToolCalls(out).map((call) => call.toolName)).toEqual(["ok"]);
    expect(onError).toHaveBeenCalledTimes(1);
    const [message, metadata] = onError.mock.calls[0];
    if (metadata === undefined) {
      throw new TypeError("Expected error metadata");
    }
    expect(message).toContain("emitting original text");
    expect(metadata).toMatchObject({
      toolCall: malformedPrefix,
      toolName: "bash",
      dropReason: "malformed-nested-tool-call",
    });
    expect(
      metadata.toolCallId === undefined ||
        typeof metadata.toolCallId === "string"
    ).toBe(true);
  });

  it("recovers a valid tool call that follows an unclosed/malformed one", async () => {
    const out = await runHermes([
      '<tool_call>{"name":"bash","arguments":{"cmd":"x </tool_call> y"}} ' +
        VALID_OK_CALL,
    ]);

    expect(out.some((part) => part.type === "finish")).toBe(true);
    expect(
      selectToolCalls(out).find((call) => call.toolName === "ok")
    ).toBeDefined();
  });
});
