import { describe, expect, it } from "vitest";
import { coerceBySchema } from "../../schema-coerce";

describe("Coercion Heuristic Handling", () => {
  describe("Tuple handling with prefixItems", () => {
    it("should handle tuple with prefixItems", () => {
      const input = {
        item: ["10.5", "hello", "true"],
      };

      const schema = {
        type: "array",
        prefixItems: [
          { type: "number" },
          { type: "string" },
          { type: "boolean" },
        ],
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([10.5, "hello", true]);
      expect(typeof result[0]).toBe("number");
      expect(typeof result[1]).toBe("string");
      expect(typeof result[2]).toBe("boolean");
    });

    it("should handle numeric keys with prefixItems", () => {
      const input = {
        "0": "123",
        "1": "hello",
        "2": "45.67",
      };

      const schema = {
        type: "array",
        prefixItems: [
          { type: "number" },
          { type: "string" },
          { type: "number" },
        ],
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([123, "hello", 45.67]);
      expect(typeof result[0]).toBe("number");
      expect(typeof result[1]).toBe("string");
      expect(typeof result[2]).toBe("number");
    });

    it("should handle single numeric key with prefixItems", () => {
      const input = {
        "0": "123",
      };

      const schema = {
        type: "array",
        prefixItems: [{ type: "number" }],
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual([123]);
      expect(typeof result[0]).toBe("number");
    });

    it("should fall back to items schema when prefixItems length mismatch", () => {
      const input = {
        item: ["10", "20", "30", "40"], // 4 items but only 2 prefixItems
      };

      const schema = {
        type: "array",
        prefixItems: [{ type: "number" }, { type: "number" }],
        items: { type: "string" }, // fallback for extra items
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual(["10", "20", "30", "40"]); // All converted as strings due to fallback
      expect(result.every((item: any) => typeof item === "string")).toBe(true);
    });
  });
});
