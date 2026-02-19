import { describe, expect, it } from "vitest";
import { coerceBySchema } from "../../schema-coerce";

describe("Coercion Heuristic Handling", () => {
  describe("Performance and scalability", () => {
    it("should handle large arrays efficiently", () => {
      const largeArray = Array.from({ length: 1000 }, (_, i) => i.toString());
      const input = { item: largeArray };

      const schema = {
        type: "array",
        items: { type: "number" },
      };

      const start = Date.now();
      const result = coerceBySchema(input, schema) as any[];
      const end = Date.now();

      const arr = result as any[];
      expect(arr).toHaveLength(1000);
      expect(arr.every((item: any) => typeof item === "number")).toBe(true);
      expect(end - start).toBeLessThan(100); // Should complete within 100ms
    });

    it("should handle deeply nested structures", () => {
      const input = {
        level1: {
          level2: {
            level3: {
              item: ["1", "2", "3"],
            },
          },
        },
      };

      const schema = {
        type: "object",
        properties: {
          level1: {
            type: "object",
            properties: {
              level2: {
                type: "object",
                properties: {
                  level3: {
                    type: "array",
                    items: { type: "number" },
                  },
                },
              },
            },
          },
        },
      };

      const result = coerceBySchema(input, schema) as any;
      expect(result.level1.level2.level3).toEqual([1, 2, 3]);
    });
  });
});
