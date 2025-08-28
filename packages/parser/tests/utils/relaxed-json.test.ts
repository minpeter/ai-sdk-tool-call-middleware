import { describe, it, expect } from "vitest";
import { parse, transform, stringify } from "@/utils/relaxed-json";

describe("relaxed-json", () => {
  describe("parse", () => {
    describe("standard JSON", () => {
      it("should parse valid JSON objects", () => {
        expect(parse('{"key": "value"}')).toEqual({ key: "value" });
        expect(parse('{"a": 1, "b": 2}')).toEqual({ a: 1, b: 2 });
        expect(parse('{"nested": {"key": "value"}}')).toEqual({
          nested: { key: "value" },
        });
      });

      it("should parse valid JSON arrays", () => {
        expect(parse("[1, 2, 3]")).toEqual([1, 2, 3]);
        expect(parse('["a", "b", "c"]')).toEqual(["a", "b", "c"]);
        expect(parse("[[1, 2], [3, 4]]")).toEqual([
          [1, 2],
          [3, 4],
        ]);
      });

      it("should parse JSON primitives", () => {
        expect(parse("null")).toBe(null);
        expect(parse("true")).toBe(true);
        expect(parse("false")).toBe(false);
        expect(parse("42")).toBe(42);
        expect(parse("-3.14")).toBe(-3.14);
        expect(parse("2.5e10")).toBe(2.5e10);
        expect(parse('"string"')).toBe("string");
      });

      it("should handle escape sequences in strings", () => {
        expect(parse('"\\n\\r\\t"')).toBe("\n\r\t");
        expect(parse('"\\u0041"')).toBe("A");
        expect(parse('"\\\\"')).toBe("\\");
        expect(parse('"\\""')).toBe('"');
      });

      it("should parse empty structures", () => {
        expect(parse("{}")).toEqual({});
        expect(parse("[]")).toEqual([]);
      });
    });

    describe("relaxed syntax", () => {
      it("should parse unquoted identifiers as keys", () => {
        expect(parse("{key: value}", { relaxed: true })).toEqual({
          key: "value",
        });
        expect(parse("{name: John, age: 30}", { relaxed: true })).toEqual({
          name: "John",
          age: 30,
        });
      });

      it("should parse single-quoted strings", () => {
        expect(parse("{'key': 'value'}", { relaxed: true })).toEqual({
          key: "value",
        });
        expect(parse("['single', 'quoted']", { relaxed: true })).toEqual([
          "single",
          "quoted",
        ]);
      });

      it("should handle trailing commas", () => {
        expect(parse("{a: 1, b: 2,}", { relaxed: true })).toEqual({
          a: 1,
          b: 2,
        });
        expect(parse("[1, 2, 3,]", { relaxed: true })).toEqual([1, 2, 3]);
        expect(parse("{a: [1, 2,], b: 3,}", { relaxed: true })).toEqual({
          a: [1, 2],
          b: 3,
        });
      });

      it("should parse comments", () => {
        const jsonWithComments = `{
          // This is a comment
          "key": "value", // inline comment
          /* multi-line
             comment */
          "number": 42
        }`;
        expect(parse(jsonWithComments, { relaxed: true })).toEqual({
          key: "value",
          number: 42,
        });
      });

      it("should handle mixed quote styles", () => {
        expect(
          parse(`{"key": 'value', 'key2': "value2"}`, { relaxed: true })
        ).toEqual({
          key: "value",
          key2: "value2",
        });
      });

      it("should parse special characters in unquoted identifiers", () => {
        expect(parse("{key-name: value}", { relaxed: true })).toEqual({
          "key-name": "value",
        });
        expect(parse("{key.name: value}", { relaxed: true })).toEqual({
          "key.name": "value",
        });
        expect(parse("{key_name: value}", { relaxed: true })).toEqual({
          key_name: "value",
        });
      });
    });

    describe("error handling", () => {
      it("should throw on invalid JSON in strict mode", () => {
        expect(() => parse("{invalid}", { relaxed: false })).toThrow();
        expect(() => parse("{key: value}", { relaxed: false })).toThrow();
        expect(() => parse("{'key': 'value'}", { relaxed: false })).toThrow();
      });

      it("should handle malformed JSON gracefully in tolerant mode", () => {
        expect(() =>
          parse("{key: }", { tolerant: true, warnings: true })
        ).toThrow();
      });

      it("should throw for unexpected characters", () => {
        expect(() => parse("@invalid", { relaxed: false })).toThrow(
          "Unexpected character"
        );
      });

      it("should handle missing closing brackets in tolerant mode", () => {
        expect(() =>
          parse('{"key": "value"', { tolerant: true, warnings: true })
        ).toThrow();
      });
    });

    describe("options", () => {
      it("should support reviver function", () => {
        const reviver = (_key: string, value: any) => {
          if (typeof value === "number") return value * 2;
          return value;
        };
        expect(parse('{"a": 1, "b": 2}', reviver)).toEqual({ a: 2, b: 4 });
      });

      it("should support reviver in options object", () => {
        const reviver = (_key: string, value: any) => {
          if (typeof value === "string") return value.toUpperCase();
          return value;
        };
        expect(parse('{"key": "value"}', { reviver })).toEqual({
          key: "VALUE",
        });
      });

      it("should check for duplicate keys when duplicate is false", () => {
        expect(() =>
          parse('{"key": 1, "key": 2}', { duplicate: false, tolerant: false })
        ).toThrow();
      });

      it("should check for default duplicate keys", () => {
        expect(() =>
          parse('{"key": 1, "key": 2}', { tolerant: false })
        ).toThrow();
      });

      it("should allow duplicate keys when duplicate is true", () => {
        expect(parse('{"key": 1, "key": 2}', { duplicate: true })).toEqual({
          key: 2,
        });
      });

      it("should collect duplicate key warnings in tolerant mode", () => {
        // In tolerant mode with warnings=false, duplicate key errors should add warnings and throw at end
        expect(() =>
          parse('{"key": 1, "key": 2}', {
            duplicate: false,
            tolerant: true,
            warnings: true,
          })
        ).toThrow(/Duplicate key: key/);
      });

      it("should collect warnings in tolerant mode", () => {
        expect(() =>
          parse("{key: , another: value}", { tolerant: true, warnings: true })
        ).toThrow(/parse warnings/);
      });

      it("should use strict lexer when relaxed is false", () => {
        expect(() => parse("{key: value}", { relaxed: false })).toThrow();
        expect(parse('{"key": "value"}', { relaxed: false })).toEqual({
          key: "value",
        });
      });
    });

    describe("edge cases", () => {
      it("should handle deeply nested structures", () => {
        const nested = '{"a": {"b": {"c": {"d": {"e": 1}}}}}';
        expect(parse(nested)).toEqual({
          a: { b: { c: { d: { e: 1 } } } },
        });
      });

      it("should handle large arrays", () => {
        const largeArray = "[" + Array(1000).fill("1").join(",") + "]";
        const result = parse(largeArray) as number[];
        expect(result).toHaveLength(1000);
        expect(result[0]).toBe(1);
      });

      it("should handle unicode in strings", () => {
        expect(parse('"emoji: 😀"')).toBe("emoji: 😀");
        expect(parse('"chinese: 中文"')).toBe("chinese: 中文");
      });

      it("should handle empty strings", () => {
        expect(parse('""')).toBe("");
        expect(parse('{"key": ""}')).toEqual({ key: "" });
      });

      it("should handle whitespace-only input in tolerant mode", () => {
        const result = parse("   \n\t  ", { tolerant: true });
        expect(result).toBeUndefined();
      });

      it("should parse numbers with different formats", () => {
        expect(parse("0")).toBe(0);
        expect(parse("-0")).toBe(-0);
        expect(parse("1e-10")).toBe(1e-10);
        expect(parse("1E+10")).toBe(1e10);
      });

      it("should handle mixed content types", () => {
        const mixed =
          '{"str": "text", "num": 42, "bool": true, "null": null, "arr": [1, 2], "obj": {"nested": "value"}}';
        expect(parse(mixed)).toEqual({
          str: "text",
          num: 42,
          bool: true,
          null: null,
          arr: [1, 2],
          obj: { nested: "value" },
        });
      });
    });
  });

  describe("transform", () => {
    it("should transform relaxed JSON to strict JSON", () => {
      const relaxed = "{key: value, trailing: 'comma',}";
      const transformed = transform(relaxed);
      expect(() => JSON.parse(transformed)).not.toThrow();
    });

    it("should preserve valid JSON", () => {
      const valid = '{"key": "value"}';
      const transformed = transform(valid);
      expect(transformed).toBe(valid);
    });

    it("should handle comments in transformation", () => {
      const withComments = '{"key": "value" /* comment */}';
      const transformed = transform(withComments);
      expect(() => JSON.parse(transformed)).not.toThrow();
    });

    it("should strip trailing commas", () => {
      const withTrailing = '{"a": 1, "b": 2,}';
      const transformed = transform(withTrailing);
      expect(transformed).toMatch(/}\s*$/);
      expect(() => JSON.parse(transformed)).not.toThrow();
    });
  });

  describe("stringify", () => {
    it("should stringify objects", () => {
      const result = stringify({ key: "value", num: 42 });
      const parsed = JSON.parse(result);
      expect(parsed).toEqual({ key: "value", num: 42 });
    });

    it("should stringify arrays", () => {
      const result = stringify([1, 2, 3]);
      expect(JSON.parse(result)).toEqual([1, 2, 3]);
    });

    it("should stringify primitives", () => {
      expect(stringify(null)).toBe("null");
      expect(stringify(true)).toBe("true");
      expect(stringify(false)).toBe("false");
      expect(stringify(42)).toBe("42");
      expect(stringify("string")).toBe('"string"');
    });

    it("should handle undefined as null", () => {
      expect(stringify(undefined as any)).toBe("null");
      expect(stringify({ key: undefined } as any)).toBe('{"key":null}');
    });

    it("should handle nested structures", () => {
      const obj = {
        a: {
          b: {
            c: [1, 2, 3],
          },
        },
      };
      const result = stringify(obj);
      expect(JSON.parse(result)).toEqual(obj);
    });

    it("should handle empty structures", () => {
      expect(stringify({})).toBe("{}");
      expect(stringify([])).toBe("[]");
    });

    it("should handle special string characters", () => {
      const result = stringify({ key: 'value with "quotes"' });
      const parsed = JSON.parse(result);
      expect(parsed.key).toBe('value with "quotes"');
    });

    it("should sort object keys", () => {
      const result = stringify({ z: 1, a: 2, m: 3 });
      expect(result).toBe('{"a":2,"m":3,"z":1}');
    });

    it("should handle functions and symbols as null", () => {
      expect(stringify((() => {}) as any)).toBe("null");
      expect(stringify(Symbol("test") as any)).toBe("null");
      expect(stringify({ fn: () => {}, sym: Symbol("test") } as any)).toBe(
        '{"fn":null,"sym":null}'
      );
    });
  });
});
