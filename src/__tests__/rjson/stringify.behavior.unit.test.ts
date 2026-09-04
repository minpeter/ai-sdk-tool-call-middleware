import { describe, expect, expectTypeOf, it } from "vitest";

import { type Rjson, stringify } from "../../rjson/index";

describe("relaxed-json", () => {
  describe("stringify", () => {
    it("accepts the complete recursive RJSON value contract", () => {
      const value = {
        array: [1, undefined, { nested: undefined }],
      } satisfies Rjson;

      const result = stringify(value);

      expectTypeOf(result).toEqualTypeOf<string>();
      expect(result).toBe('{"array":[1,null,{"nested":null}]}');
    });

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
      expect(stringify(undefined)).toBe("null");
      expect(stringify({ key: undefined })).toBe('{"key":null}');
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

    it("should handle unsupported runtime functions and symbols as null", () => {
      const value = {
        fn: () => {
          /* empty */
        },
        sym: Symbol("test"),
      };

      expect(Reflect.apply(stringify, undefined, [value.fn])).toBe("null");
      expect(Reflect.apply(stringify, undefined, [value.sym])).toBe("null");
      expect(Reflect.apply(stringify, undefined, [value])).toBe(
        '{"fn":null,"sym":null}'
      );
    });
  });
});
