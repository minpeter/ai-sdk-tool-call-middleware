import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  repairToolCallJsonForTools,
  topLevelNullArgumentMatchesToolSchema,
} from "../../../core/protocols/hermes-json-repair";

function makeTool(
  name: string,
  inputSchema: LanguageModelV4FunctionTool["inputSchema"]
): LanguageModelV4FunctionTool {
  return { type: "function", name, inputSchema };
}

const NO_TOOLS: LanguageModelV4FunctionTool[] = [];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("topLevelNullArgumentMatchesToolSchema", () => {
  it("returns false when the named tool is absent", () => {
    // Given
    const tools = [makeTool("other", { type: "null" })];

    // When
    const matches = topLevelNullArgumentMatchesToolSchema("write", tools);

    // Then
    expect(matches).toBe(false);
  });

  it("returns false when the named tool has no schema", () => {
    // Given
    const tool = makeTool("write", {});
    Reflect.deleteProperty(tool, "inputSchema");
    const tools = [tool];

    // When
    const matches = topLevelNullArgumentMatchesToolSchema("write", tools);

    // Then
    expect(matches).toBe(false);
  });

  it("matches null against nullable and non-nullable schemas", () => {
    // Given
    const nullableTools = [makeTool("write", { type: "null" })];
    const objectTools = [makeTool("write", { type: "object" })];

    // When
    const nullableMatches = topLevelNullArgumentMatchesToolSchema(
      "write",
      nullableTools
    );
    const objectMatches = topLevelNullArgumentMatchesToolSchema(
      "write",
      objectTools
    );

    // Then
    expect(nullableMatches).toBe(true);
    expect(objectMatches).toBe(false);
  });
});

describe("repairToolCallJsonForTools", () => {
  it("returns null when the tool name is absent", () => {
    // Given
    const raw = '{"arguments":{"value":1}}';

    // When
    const repaired = repairToolCallJsonForTools(raw, NO_TOOLS);

    // Then
    expect(repaired).toBeNull();
  });

  it("returns strict arguments unchanged when repair is unnecessary", () => {
    // Given
    const raw = '{"name":"read","arguments":{"path":"/tmp/a"}}   ';

    // When
    const repaired = repairToolCallJsonForTools(raw, NO_TOOLS);

    // Then
    expect(repaired).toEqual({
      name: "read",
      arguments: { path: "/tmp/a" },
    });
  });

  it("returns null when a strict schema rejects every argument", () => {
    // Given
    const raw = '{"name":"read","arguments":{"path":"/tmp/a"}}';
    const tool = makeTool("read", {});
    Object.defineProperty(tool, "inputSchema", { value: false });
    const tools = [tool];

    // When
    const repaired = repairToolCallJsonForTools(raw, tools);

    // Then
    expect(repaired).toBeNull();
  });

  it("falls back to per-value repair when parsed arguments are not an object", () => {
    // Given
    const originalJsonParse = JSON.parse;
    vi.spyOn(JSON, "parse").mockImplementation((text) =>
      text === '{"path":"/tmp/a"}' ? null : originalJsonParse(text)
    );

    // When
    const repaired = repairToolCallJsonForTools(
      '{"name":"read","arguments":{"path":"/tmp/a"}}',
      NO_TOOLS
    );

    // Then
    expect(repaired).toEqual({
      name: "read",
      arguments: { path: "/tmp/a" },
    });
  });

  it("returns null when arguments are not an object", () => {
    // Given
    const raw = '{"name":"read","arguments":null}';

    // When
    const repaired = repairToolCallJsonForTools(raw, NO_TOOLS);

    // Then
    expect(repaired).toBeNull();
  });

  it("returns null when the arguments object has no strict first key", () => {
    // Given
    const raw = '{"name":"read","arguments":{path:nope}}';

    // When
    const repaired = repairToolCallJsonForTools(raw, NO_TOOLS);

    // Then
    expect(repaired).toBeNull();
  });

  it("returns null when a likely arguments close has an invalid suffix", () => {
    // Given
    const raw = '{"name":"read","arguments":{"path":"/tmp/a"}suffix';

    // When
    const repaired = repairToolCallJsonForTools(raw, NO_TOOLS);

    // Then
    expect(repaired).toBeNull();
  });

  it("returns null when the only trailing brace cannot close arguments", () => {
    // Given
    const raw = '{"name":"read","arguments":{"path":"/tmp/a"   }';

    // When
    const repaired = repairToolCallJsonForTools(raw, NO_TOOLS);

    // Then
    expect(repaired).toBeNull();
  });

  it("repairs malformed quotes while preserving nested key-like text", () => {
    // Given
    const raw =
      '{"name":"edit","arguments":{"options":{"nested":1},"content":"say "hello" now"}}';

    // When
    const repaired = repairToolCallJsonForTools(raw, NO_TOOLS);

    // Then
    expect(repaired).toEqual({
      name: "edit",
      arguments: {
        options: { nested: 1 },
        content: 'say "hello" now',
      },
    });
  });

  it("repairs literal string control characters", () => {
    // Given
    const raw =
      '{"name":"write","arguments":{"content":"line 1\nline 2\r\tend with "quote""}}';

    // When
    const repaired = repairToolCallJsonForTools(raw, NO_TOOLS);

    // Then
    expect(repaired?.arguments.content).toBe(
      'line 1\nline 2\r\tend with "quote"'
    );
  });

  it("returns null for an invalid Unicode escape in a malformed string", () => {
    // Given
    const raw = String.raw`{"name":"write","arguments":{"content":"bad \uZZZZ and "quote""}}`;

    // When
    const repaired = repairToolCallJsonForTools(raw, NO_TOOLS);

    // Then
    expect(repaired).toBeNull();
  });

  it("returns null when repaired string parsing yields a non-JSON value", () => {
    // Given
    const originalJsonParse = JSON.parse;
    vi.spyOn(JSON, "parse").mockImplementation((text) =>
      text === String.raw`"say \"hello\""`
        ? Symbol("non-json")
        : originalJsonParse(text)
    );
    const raw = '{"name":"write","arguments":{"content":"say "hello""}}';

    // When
    const repaired = repairToolCallJsonForTools(raw, NO_TOOLS);

    // Then
    expect(repaired).toBeNull();
  });

  it("returns null when strict value parsing yields a non-JSON value", () => {
    // Given
    const originalJsonParse = JSON.parse;
    vi.spyOn(JSON, "parse").mockImplementation((text) =>
      text === "1" ? Symbol("non-json") : originalJsonParse(text)
    );
    const raw =
      '{"name":"write","arguments":{"count":1,"content":"say "hello""}}';

    // When
    const repaired = repairToolCallJsonForTools(raw, NO_TOOLS);

    // Then
    expect(repaired).toBeNull();
  });

  it("returns null when repair produces no enumerable arguments", () => {
    // Given
    const originalObjectKeys = Object.keys;
    vi.spyOn(Object, "keys").mockImplementation((value) =>
      Object.getPrototypeOf(value) === null ? [] : originalObjectKeys(value)
    );
    const raw = '{"name":"write","arguments":{"content":"say "hello""}}';

    // When
    const repaired = repairToolCallJsonForTools(raw, NO_TOOLS);

    // Then
    expect(repaired).toBeNull();
  });

  it("returns null for an unterminated argument string", () => {
    // Given
    const raw = '{"name":"write","arguments":{"content":"unfinished}}';

    // When
    const repaired = repairToolCallJsonForTools(raw, NO_TOOLS);

    // Then
    expect(repaired).toBeNull();
  });

  it("returns null when a malformed primitive cannot be repaired", () => {
    // Given
    const raw = '{"name":"calc","arguments":{"value":4.2.3}}';

    // When
    const repaired = repairToolCallJsonForTools(raw, NO_TOOLS);

    // Then
    expect(repaired).toBeNull();
  });

  it("chooses the valid last occurrence of a duplicate key", () => {
    // Given
    const raw =
      '{"name":"edit","arguments":{"content":"broken "quote"","content":"valid"}}';

    // When
    const repaired = repairToolCallJsonForTools(raw, NO_TOOLS);

    // Then
    expect(repaired?.arguments).toEqual({ content: "valid" });
  });

  it("chooses a repairable last duplicate over an unrepairable first one", () => {
    // Given
    const raw =
      '{"name":"edit","arguments":{"content":4.2.3,"content":"valid "quote""}}';

    // When
    const repaired = repairToolCallJsonForTools(raw, NO_TOOLS);

    // Then
    expect(repaired?.arguments).toEqual({ content: 'valid "quote"' });
  });

  it("keeps the first duplicate when neither occurrence is repairable", () => {
    // Given
    const raw = '{"name":"edit","arguments":{"content":4.2.3,"content":5.6.7}}';

    // When
    const repaired = repairToolCallJsonForTools(raw, NO_TOOLS);

    // Then
    expect(repaired).toBeNull();
  });

  it("scores multiple retained positions while resolving a duplicate", () => {
    // Given
    const raw =
      '{"name":"edit","arguments":{"content":4.2.3,"path":"/tmp/a","content":"fixed "quote""}}';

    // When
    const repaired = repairToolCallJsonForTools(raw, NO_TOOLS);

    // Then
    expect(repaired?.arguments).toEqual({
      path: "/tmp/a",
      content: 'fixed "quote"',
    });
  });

  it("returns null for a top-level primitive following the arguments object", () => {
    // Given
    const raw =
      '{"name":"edit","arguments":{"content":"broken "quote""} \n, 123}}';

    // When
    const repaired = repairToolCallJsonForTools(raw, NO_TOOLS);

    // Then
    expect(repaired).toBeNull();
  });

  it("repairs the argument before an unmatched close without a comma", () => {
    // Given
    const raw = '{"name":"edit","arguments":{"content":"broken "quote""} 123}}';

    // When
    const repaired = repairToolCallJsonForTools(raw, NO_TOOLS);

    // Then
    expect(repaired?.arguments).toEqual({ content: 'broken "quote"' });
  });

  it("returns null for a prototype-sensitive key", () => {
    // Given
    const raw = '{"name":"edit","arguments":{"constructor":"pollute"}}';

    // When
    const repaired = repairToolCallJsonForTools(raw, NO_TOOLS);

    // Then
    expect(repaired).toBeNull();
  });

  it("returns null for a strict field following the arguments object", () => {
    // Given
    const raw =
      '{"name":"edit","arguments":{"content":"broken "quote""}, "id":"call-1"}';

    // When
    const repaired = repairToolCallJsonForTools(raw, NO_TOOLS);

    // Then
    expect(repaired).toBeNull();
  });

  it("returns null when the arguments body exceeds the repair size limit", () => {
    // Given
    const raw = `{"name":"write","arguments":{"content":"${"x".repeat(102_401)} "quote""}}`;

    // When
    const repaired = repairToolCallJsonForTools(raw, NO_TOOLS);

    // Then
    expect(repaired).toBeNull();
  });

  it("returns null when JSON nesting exceeds the repair depth limit", () => {
    // Given
    const nested = `${"[".repeat(257)}0${"]".repeat(257)}`;
    const raw = `{"name":"deep","arguments":{"value":${nested}}}`;

    // When
    const repaired = repairToolCallJsonForTools(raw, NO_TOOLS);

    // Then
    expect(repaired).toBeNull();
  });

  it("returns null when tool policy extraction throws", () => {
    // Given
    const tools = new Proxy(NO_TOOLS, {
      get(target, property, receiver) {
        if (property === "find") {
          throw new TypeError("inaccessible tool registry");
        }
        return Reflect.get(target, property, receiver);
      },
    });

    // When
    const repaired = repairToolCallJsonForTools(
      '{"name":"read","arguments":{"path":"/tmp/a"}}',
      tools
    );

    // Then
    expect(repaired).toBeNull();
  });
});
