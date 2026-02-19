import { describe, expect, it } from "vitest";

import { stringify } from "../../rjson/index";

describe("relaxed-json", () => {
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
      expect(
        stringify((() => {
          /* empty */
        }) as any)
      ).toBe("null");
      expect(stringify(Symbol("test") as any)).toBe("null");
      expect(
        stringify({
          fn: () => {
            /* empty */
          },
          sym: Symbol("test"),
        } as any)
      ).toBe('{"fn":null,"sym":null}');
    });
  });
});
