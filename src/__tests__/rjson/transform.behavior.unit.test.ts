import { describe, expect, it } from "vitest";

import { transform } from "../../rjson/index";

const TRAILING_BRACE_REGEX = /}\s*$/;

describe("relaxed-json", () => {
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
      expect(transformed).toMatch(TRAILING_BRACE_REGEX);
      expect(() => JSON.parse(transformed)).not.toThrow();
    });
  });
});
