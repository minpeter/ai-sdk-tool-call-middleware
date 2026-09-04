import { describe, expect, it } from "vitest";

import { decodeJsonStringLiteral } from "../../rjson/json-string-decoder";
import { lexer, strictLexer } from "../../rjson/lexer";

const MALFORMED_JSON_STRING_LITERALS = [
  "",
  'missing opening quote"',
  '"missing closing quote',
  String.raw`"bad\xescape"`,
  String.raw`"short\u123"`,
  String.raw`"bad\u12G4"`,
  String.raw`"escaped closing quote\"`,
  '"embedded " quote"',
  '"raw\ncontrol"',
] as const;

describe("decodeJsonStringLiteral", () => {
  it("decodes every simple JSON escape when the literal is valid", () => {
    // Given
    const literal = String.raw`"\"\\\/\b\f\n\r\t"`;

    // When
    const decoded = decodeJsonStringLiteral(literal);

    // Then
    expect(decoded).toBe(
      ['"', "\\", "/", "\b", "\f", "\n", "\r", "\t"].join("")
    );
  });

  it("decodes BMP and surrogate-pair Unicode code units when escaped", () => {
    // Given
    const literal = String.raw`"\u0041\uD83D\uDE00"`;

    // When
    const decoded = decodeJsonStringLiteral(literal);

    // Then
    expect(decoded).toBe("A😀");
  });

  it("preserves unescaped non-control Unicode when the literal is valid", () => {
    // Given
    const literal = '"café 😀"';

    // When
    const decoded = decodeJsonStringLiteral(literal);

    // Then
    expect(decoded).toBe("café 😀");
  });

  it.each(MALFORMED_JSON_STRING_LITERALS)(
    "throws SyntaxError when the literal is malformed: %s",
    (literal) => {
      // Given
      const decode = () => decodeJsonStringLiteral(literal);

      // When / Then
      expect(decode).toThrow(SyntaxError);
    }
  );
});

describe("RJSON string lexer integration", () => {
  it("decodes JSON escapes through the strict lexer", () => {
    // Given
    const literal = String.raw`"\"\\\/\b\f\n\r\t\u0041\uD83D\uDE00"`;

    // When
    const tokens = strictLexer(literal);

    // Then
    expect(tokens[0]?.value).toBe(
      ['"', "\\", "/", "\b", "\f", "\n", "\r", "\t", "A😀"].join("")
    );
  });

  it("preserves single-quoted transformation and escape decoding", () => {
    // Given
    const literal = String.raw`'single\' quote "double" \u0041'`;

    // When
    const tokens = lexer(literal);

    // Then
    expect(tokens[0]?.value).toBe(`single' quote "double" A`);
  });
});
