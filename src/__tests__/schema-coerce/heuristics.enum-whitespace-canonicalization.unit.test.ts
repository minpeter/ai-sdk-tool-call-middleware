import { describe, expect, it } from "vitest";
import { coerceBySchema } from "../../schema-coerce";

describe("Coercion Heuristic Handling", () => {
  describe("Enum whitespace canonicalization", () => {
    it("canonicalizes quoted enum tokens when quote removal yields a unique match", () => {
      const result = coerceBySchema("'high'", {
        type: "string",
        enum: ["low", "normal", "high"],
      });

      expect(result).toBe("high");
    });

    it("canonicalizes spaced enum tokens when there is exactly one match", () => {
      const result = coerceBySchema("1 d", {
        type: "string",
        enum: ["1d", "1w", "1m"],
      });

      expect(result).toBe("1d");
    });

    it("does not canonicalize ambiguous enum matches", () => {
      const result = coerceBySchema("a b", {
        type: "string",
        enum: ["ab", "a b"],
      });

      expect(result).toBe("a b");
    });

    it("does not canonicalize when enum includes non-string values", () => {
      const result = coerceBySchema("1 d", {
        type: "string",
        enum: [1, "1d"],
      });

      expect(result).toBe("1 d");
    });
  });
});
