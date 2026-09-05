import {
  isJSONObject,
  isJSONValue,
  type JSONObject,
  type JSONValue,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { defineReviver, parse, type RevivedValue } from "../../rjson/index";

const DUPLICATE_KEY_REGEX = /Duplicate key: key/;
const PARSE_WARNINGS_REGEX = /parse warnings/;

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

      it("preserves __proto__ as an own data property", () => {
        const parsedValue = parse(
          '{"__proto__":{"polluted":"top"},"safe":{"__proto__":{"polluted":"nested"}}}'
        );
        if (!isJSONObject(parsedValue)) {
          throw new TypeError("Expected parsed JSON object");
        }
        const parsed: JSONObject = parsedValue;
        const nestedValue: JSONValue | undefined = parsed.safe;
        if (!isJSONObject(nestedValue)) {
          throw new TypeError("Expected nested JSON object");
        }
        const nested: JSONObject = nestedValue;

        expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
        expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
        expect(
          Object.getOwnPropertyDescriptor(parsed, "__proto__")?.value
        ).toEqual({ polluted: "top" });
        expect(Object.getPrototypeOf(nested)).toBe(Object.prototype);
        expect(Object.hasOwn(nested, "__proto__")).toBe(true);
        expect(
          Object.getOwnPropertyDescriptor(nested, "__proto__")?.value
        ).toEqual({ polluted: "nested" });
        expect(
          Object.getOwnPropertyDescriptor(Object.prototype, "polluted")
        ).toBeUndefined();
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
        expect(
          parse('{"a": 1, "b": 2}', (_key, value) => {
            if (typeof value === "number") {
              return value * 2;
            }
            return value;
          })
        ).toEqual({ a: 2, b: 4 });
      });

      it("should support reviver in options object", () => {
        expect(
          parse('{"key": "value"}', {
            reviver: (_key, value) => {
              if (typeof value === "string") {
                return value.toUpperCase();
              }
              return value;
            },
          })
        ).toEqual({
          key: "VALUE",
        });
      });

      it("binds an object property reviver to its holder like JSON.parse", () => {
        function readSibling(
          this: Record<string, JSONValue>,
          key: string,
          value: JSONValue | undefined
        ): JSONValue | undefined {
          return key === "a" ? this.b : value;
        }
        const text = '{"a":1,"b":2}';

        expect(parse(text, readSibling)).toEqual(JSON.parse(text, readSibling));
        expect(parse(text, readSibling)).toEqual({ a: 2, b: 2 });
      });

      it("binds an array element reviver to its holder like JSON.parse", () => {
        function readNextElement(
          this: JSONValue[],
          key: string,
          value: JSONValue | undefined
        ): JSONValue | undefined {
          return key === "0" ? this[1] : value;
        }
        const text = "[1,2]";

        expect(parse(text, readNextElement)).toEqual(
          JSON.parse(text, readNextElement)
        );
      });

      it("preserves reviver deletion like JSON.parse", () => {
        function deleteProperty(
          key: string,
          value: JSONValue | undefined
        ): JSONValue | undefined {
          return key === "a" ? undefined : value;
        }
        const text = '{"a":1,"b":2}';

        expect(parse(text, deleteProperty)).toEqual(
          JSON.parse(text, deleteProperty)
        );
      });

      it("passes undefined when an earlier callback deletes a later sibling", () => {
        const text = '{"a":1,"b":2}';
        const rjsonValues: Array<JSONValue | undefined> = [];
        const nativeValues: Array<JSONValue | undefined> = [];
        const createReviver = (values: Array<JSONValue | undefined>) =>
          function deleteLaterSibling(
            this: Record<string, JSONValue | undefined>,
            key: string,
            value: JSONValue | undefined
          ): JSONValue | undefined {
            if (key === "a") {
              Reflect.deleteProperty(this, "b");
            } else if (key === "b") {
              values.push(value);
            }
            return value;
          };

        const revived = parse(text, createReviver(rjsonValues));
        const native = JSON.parse(text, createReviver(nativeValues));

        expect(revived).toEqual(native);
        expect(rjsonValues).toEqual([undefined]);
        expect(rjsonValues).toEqual(nativeValues);
      });

      it("recursively visits a callable replacement like JSON.parse", () => {
        type CallableReplacement = (() => string) & { child: number };
        type CallableValue = RevivedValue<CallableReplacement> | undefined;

        const createReviver = (calls: string[]) =>
          defineReviver<CallableReplacement>(function replaceLaterSibling(
            this: Record<string, CallableValue>,
            key: string,
            value: CallableValue
          ): CallableValue {
            calls.push(key);
            if (key === "a") {
              this.b = Object.assign(() => "replacement", { child: 1 });
            }
            return key === "child" && typeof value === "number"
              ? value + 1
              : value;
          });
        const text = '{"a":1,"b":2}';
        const rjsonCalls: string[] = [];
        const nativeCalls: string[] = [];

        const revived = parse(text, createReviver(rjsonCalls));
        const native = JSON.parse(text, createReviver(nativeCalls));

        expect(rjsonCalls).toEqual(["a", "child", "b", ""]);
        expect(rjsonCalls).toEqual(nativeCalls);
        expect((revived as { b: CallableReplacement }).b.child).toBe(
          (native as { b: CallableReplacement }).b.child
        );
        expect((revived as { b: CallableReplacement }).b()).toBe(
          (native as { b: CallableReplacement }).b()
        );
      });

      it("preserves reviver-created array holes like JSON.parse", () => {
        function deleteElement(
          key: string,
          value: JSONValue | undefined
        ): JSONValue | undefined {
          return key === "0" ? undefined : value;
        }
        const text = "[1,2]";
        const revived = parse(text, deleteElement);

        expect(revived).toEqual(JSON.parse(text, deleteElement));
        if (!Array.isArray(revived)) {
          throw new TypeError("Expected revived JSON array");
        }
        expect(Object.hasOwn(revived, 0)).toBe(false);
      });

      it("binds the root reviver to a wrapper like JSON.parse", () => {
        const holderKeys: string[][] = [];
        function inspectRoot(
          this: Record<string, JSONValue>,
          key: string,
          value: JSONValue | undefined
        ): JSONValue | undefined {
          if (key === "") {
            holderKeys.push(Object.keys(this));
          }
          return value;
        }

        expect(parse("1", inspectRoot)).toEqual(JSON.parse("1", inspectRoot));
        expect(holderKeys).toEqual([[""], [""]]);
      });

      it("ignores property recreation after a reviver freezes its holder", () => {
        function freezeHolder(
          this: Record<string, JSONValue>,
          key: string,
          value: JSONValue | undefined
        ): JSONValue | undefined {
          if (key === "a") {
            Object.freeze(this);
          }
          return value;
        }
        const text = '{"a":1,"b":2}';

        expect(parse(text, freezeHolder)).toEqual(
          JSON.parse(text, freezeHolder)
        );
        expect(parse(text, freezeHolder)).toEqual({ a: 1, b: 2 });
      });

      it("keeps a sibling made non-configurable by an earlier callback", () => {
        function lockSibling(
          this: Record<string, JSONValue>,
          key: string,
          value: JSONValue | undefined
        ): JSONValue | undefined {
          if (key === "a") {
            Object.defineProperty(this, "b", {
              configurable: false,
              enumerable: true,
              value: 7,
            });
          }
          return key === "b" ? 9 : value;
        }
        const text = '{"a":1,"b":2}';

        expect(parse(text, lockSibling)).toEqual(JSON.parse(text, lockSibling));
        expect(parse(text, lockSibling)).toEqual({ a: 1, b: 7 });
      });

      it("matches native reviver context.source for numeric primitives", () => {
        const text = '{"amount":1.2300e+4}';
        const collectSources =
          (sources: Array<string | undefined>) =>
          (
            key: string,
            value: JSONValue | undefined,
            context?: { readonly source: string }
          ): JSONValue | undefined => {
            if (key === "amount") {
              sources.push(context?.source);
            }
            return value;
          };
        const rjsonSources: Array<string | undefined> = [];
        const nativeSources: Array<string | undefined> = [];

        const revived = parse(text, {
          duplicate: true,
          relaxed: false,
          reviver: collectSources(rjsonSources),
          tolerant: false,
          warnings: false,
        });
        const native = JSON.parse(text, collectSources(nativeSources));

        expect(revived).toEqual(native);
        expect(rjsonSources).toEqual(nativeSources);
        expect(rjsonSources).toEqual(["1.2300e+4"]);
      });

      it("visits only the final duplicate value with a holder like JSON.parse", () => {
        function readSibling(
          this: Record<string, JSONValue>,
          key: string,
          value: JSONValue | undefined
        ): JSONValue | undefined {
          return key === "a" ? this.b : value;
        }
        const text = '{"a":0,"a":1,"b":2}';

        expect(
          parse(text, {
            duplicate: true,
            relaxed: false,
            reviver: readSibling,
          })
        ).toEqual(JSON.parse(text, readSibling));
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
        ).toThrow(DUPLICATE_KEY_REGEX);
      });

      it("should collect warnings in tolerant mode", () => {
        expect(() =>
          parse("{key: , another: value}", { tolerant: true, warnings: true })
        ).toThrow(PARSE_WARNINGS_REGEX);
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
        const largeArray = `[${new Array(1000).fill("1").join(",")}]`;
        const parsed = parse(largeArray);
        if (!(isJSONValue(parsed) && Array.isArray(parsed))) {
          throw new TypeError("Expected parsed JSON array");
        }
        const result: JSONValue[] = parsed;
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
});
