import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDebugLevel,
  logParsedSummary,
  logParseFailure,
  logRawChunk,
} from "../../../core/utils/debug";

describe("debug utility branch coverage", () => {
  let originalEnvironment: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnvironment = { ...process.env };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = originalEnvironment;
    vi.restoreAllMocks();
  });

  it.each([
    [undefined, "off"],
    ["", "off"],
    ["off", "off"],
    ["0", "off"],
    ["false", "off"],
    ["no", "off"],
    ["stream", "stream"],
    ["1", "stream"],
    ["true", "stream"],
    ["yes", "stream"],
    ["parse", "parse"],
    ["2", "parse"],
  ] as const)(
    "returns %s when DEBUG_PARSER_MW is %s",
    (environmentValue, expectedLevel) => {
      // Given
      if (environmentValue === undefined) {
        delete process.env.DEBUG_PARSER_MW;
      } else {
        process.env.DEBUG_PARSER_MW = environmentValue;
      }

      // When
      const level = getDebugLevel();

      // Then
      expect(level).toBe(expectedLevel);
    }
  );

  it.each([
    ["STREAM", "stream"],
    ["PARSE", "parse"],
    ["OFF", "off"],
    [" 1 ", "stream"],
    [" TRUE ", "stream"],
    [" Yes ", "stream"],
    [" FALSE ", "off"],
    [" 0 ", "off"],
    [" No ", "off"],
    [" 2 ", "off"],
    ["verbose", "off"],
  ] as const)(
    "normalizes DEBUG_PARSER_MW value %s to %s",
    (environmentValue, expectedLevel) => {
      // Given
      process.env.DEBUG_PARSER_MW = environmentValue;

      // When
      const level = getDebugLevel();

      // Then
      expect(level).toBe(expectedLevel);
    }
  );

  it("defaults to off when the process global is unavailable", () => {
    // Given
    vi.stubGlobal("process", undefined);

    // When
    const level = getDebugLevel();

    // Then
    expect(level).toBe("off");
  });

  it("defaults to off when process has no environment", () => {
    // Given
    vi.stubGlobal("process", {});

    // When
    const level = getDebugLevel();

    // Then
    expect(level).toBe("off");
  });

  it("normalizes non-string environment values after the direct cases", () => {
    // Given
    vi.stubGlobal("process", {
      env: { DEBUG_PARSER_MW: { toString: () => "2" } },
    });

    // When
    const level = getDebugLevel();

    // Then
    expect(level).toBe("parse");
  });

  it("does not log parse failures when parse logging is disabled", () => {
    // Given
    process.env.DEBUG_PARSER_MW = "stream";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // When
    logParseFailure({ phase: "stream", reason: "E_DISABLED" });

    // Then
    expect(log).not.toHaveBeenCalled();
  });

  it("logs a short snippet and string error without truncation", () => {
    // Given
    process.env.DEBUG_PARSER_MW = "parse";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // When
    logParseFailure({
      phase: "stream",
      reason: "E_PARSE",
      snippet: "short-input",
      error: "E_STRING",
    });

    // Then
    expect(log).toHaveBeenCalledTimes(3);
    expect(log.mock.calls[1]?.[1]).toContain("short-input");
    expect(log.mock.calls[2]?.[1]).toContain("E_STRING");
  });

  it("truncates parse failure snippets beyond the debug limit", () => {
    // Given
    process.env.DEBUG_PARSER_MW = "parse";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // When
    logParseFailure({
      phase: "stream",
      reason: "E_PARSE",
      snippet: "x".repeat(805),
    });

    // Then
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1]?.[1]).toContain("[truncated 6 chars]");
  });

  it.each([true, false])(
    "formats Error values when stack presence is %s",
    (hasStack) => {
      // Given
      process.env.DEBUG_PARSER_MW = "parse";
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const error = new TypeError("E_TYPED");
      Object.defineProperty(error, "stack", {
        configurable: true,
        value: hasStack ? "STACK_TOKEN" : undefined,
      });

      // When
      logParseFailure({ phase: "stream", reason: "E_PARSE", error });

      // Then
      expect(log).toHaveBeenCalledTimes(2);
      expect(log.mock.calls[1]?.[1]).toContain("TypeError: E_TYPED");
      expect(log.mock.calls[1]?.[1].includes("STACK_TOKEN")).toBe(hasStack);
    }
  );

  it("formats serializable non-Error values", () => {
    // Given
    process.env.DEBUG_PARSER_MW = "parse";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // When
    logParseFailure({
      phase: "stream",
      reason: "E_PARSE",
      error: { code: 17 },
    });

    // Then
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1]?.[1]).toContain('"code": 17');
  });

  it("falls back to string conversion for cyclic error values", () => {
    // Given
    process.env.DEBUG_PARSER_MW = "parse";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error: Record<string, unknown> = {};
    error.self = error;

    // When
    logParseFailure({ phase: "stream", reason: "E_PARSE", error });

    // Then
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1]?.[1]).toContain("[object Object]");
  });

  it("does not log absent optional parse failure details", () => {
    // Given
    process.env.DEBUG_PARSER_MW = "parse";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // When
    logParseFailure({ phase: "stream", reason: "E_PARSE" });

    // Then
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("formats raw string chunks", () => {
    // Given
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // When
    logRawChunk("raw-token");

    // Then
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[1]).toContain("raw-token");
  });

  it("styles both empty and populated summary lines", () => {
    // Given
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // When
    logParsedSummary({
      originalText: "",
      toolCalls: [
        {
          type: "tool-call",
          toolCallId: "call-17",
          toolName: "tool-17",
          input: {},
        },
      ],
    });

    // Then
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[1]).toContain("call-17");
  });

  it.each([
    ["inverse", 7],
    ["invert", 7],
    ["underline", 4],
    ["ul", 4],
    ["bold", 1],
    ["bg", 42],
    ["background", 42],
    [" TRUE ", 42],
    ["false", 42],
    ["unexpected", 42],
    ["", 42],
  ] as const)("renders style %s with ANSI code %s", (style, ansiCode) => {
    // Given
    process.env.DEBUG_PARSER_MW_STYLE = style;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // When
    logParsedSummary({ originalText: "first\n\nsecond", toolCalls: [] });

    // Then
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[1]).toBe(
      `\n\u001b[${ansiCode}mfirst\u001b[0m\n\n\u001b[${ansiCode}msecond\u001b[0m`
    );
  });

  it("does not log an empty parsed summary", () => {
    // Given
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // When
    logParsedSummary({ originalText: "", toolCalls: [] });

    // Then
    expect(log).not.toHaveBeenCalled();
  });
});
