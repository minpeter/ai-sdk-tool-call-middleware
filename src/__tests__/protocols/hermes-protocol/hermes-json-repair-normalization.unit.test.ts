import { describe, expect, it } from "vitest";
import { normalizeInvalidJsonEscapes } from "../../../core/protocols/hermes-json-repair";

describe("normalizeInvalidJsonEscapes", () => {
  it("returns the original string when every escape is valid", () => {
    // Given
    const json = String.raw`{"double":"quote: \" slash: \\ newline: \n","single":'it\'s fine'}`;

    // When
    const normalized = normalizeInvalidJsonEscapes(json);

    // Then
    expect(normalized).toBe(json);
  });

  it("drops invalid escapes inside both quote styles but not outside strings", () => {
    // Given
    const json = String.raw`\outside "cost: \$5" 'path: \q'`;

    // When
    const normalized = normalizeInvalidJsonEscapes(json);

    // Then
    expect(normalized).toBe(String.raw`\outside "cost: $5" 'path: q'`);
  });

  it("preserves a trailing backslash in an unterminated string", () => {
    // Given
    const json = '{"value":"unfinished\\';

    // When
    const normalized = normalizeInvalidJsonEscapes(json);

    // Then
    expect(normalized).toBe(json);
  });
});
