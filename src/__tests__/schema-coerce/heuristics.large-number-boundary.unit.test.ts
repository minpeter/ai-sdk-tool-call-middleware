import { describe, expect, it } from "vitest";

import { coerceBySchema } from "../../schema-coerce";

describe("Coercion Heuristic Handling", () => {
  describe("Large numeric string boundaries", () => {
    it("coerces finite large integer-like strings to number", () => {
      const raw = "9007199254740993";

      const result = coerceBySchema(raw, { type: "integer" });

      expect(typeof result).toBe("number");
      expect(result).toBe(Number(raw));
    });

    it("keeps overflow scientific-notation strings as string", () => {
      const result = coerceBySchema("1e400", { type: "number" });

      expect(result).toBe("1e400");
      expect(typeof result).toBe("string");
    });

    it("keeps very long digit strings as string when conversion is not finite", () => {
      const raw = "9".repeat(500);

      const result = coerceBySchema(raw, { type: "integer" });

      expect(result).toBe(raw);
      expect(typeof result).toBe("string");
    });
  });
});
