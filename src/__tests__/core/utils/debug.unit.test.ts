import { afterEach, describe, expect, it, vi } from "vitest";
import {
  logParsedChunk,
  logParsedSummary,
  logParseFailure,
  logRawChunk,
} from "../../../core/utils/debug";
import { REDACTED_SENSITIVE_TOOL_CALL_TEXT } from "../../../core/utils/protocol-utils";

describe("debug logging", () => {
  const previousDebug = process.env.DEBUG_PARSER_MW;

  afterEach(() => {
    if (previousDebug === undefined) {
      delete process.env.DEBUG_PARSER_MW;
    } else {
      process.env.DEBUG_PARSER_MW = previousDebug;
    }
    vi.restoreAllMocks();
  });

  it("redacts prototype-sensitive raw provider chunks", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const part = JSON.parse(
      '{"type":"text-delta","delta":"<tool_call>{\\"name\\":\\"pollute\\",\\"arguments\\":{\\"constructor\\":{}}}</tool_call>"}'
    );

    logRawChunk(part);

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain(REDACTED_SENSITIVE_TOOL_CALL_TEXT);
    expect(output).not.toContain("constructor");
  });

  it("redacts prototype-sensitive parse failure snippets", () => {
    process.env.DEBUG_PARSER_MW = "parse";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logParseFailure({
      phase: "generated-text",
      reason: "invalid JSON",
      snippet: '{"name":"pollute","arguments":{"__proto__":{}}}',
    });

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain(REDACTED_SENSITIVE_TOOL_CALL_TEXT);
    expect(output).not.toContain("__proto__");
  });

  it("redacts prototype-sensitive normalized output chunks", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logParsedChunk({
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "provider_tool",
      providerExecuted: true,
      input: '{"constructor":{"polluted":true}}',
    });

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain(REDACTED_SENSITIVE_TOOL_CALL_TEXT);
    expect(output).not.toContain("constructor");
    expect(output).not.toContain("polluted");
  });

  it("redacts prototype-sensitive parsed summaries", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logParsedSummary({
      originalText: '{"arguments":{"prototype":{"polluted":true}}}',
      toolCalls: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "pollute",
          input: { prototype: { polluted: true } },
        },
      ],
    });

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain(REDACTED_SENSITIVE_TOOL_CALL_TEXT);
    expect(output).not.toContain("prototype");
    expect(output).not.toContain("polluted");
  });
});
