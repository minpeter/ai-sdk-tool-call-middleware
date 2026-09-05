import type { JSONObject, JSONSchema7, JSONValue } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { coerceBySchema } from "../../schema-coerce";

describe("Coercion Heuristic Handling", () => {
  describe("Performance and scalability", () => {
    it("should handle large arrays efficiently", () => {
      const largeArray = Array.from({ length: 1000 }, (_, i) => i.toString());
      const input = { item: largeArray };

      const schema: JSONSchema7 = {
        type: "array",
        items: { type: "number" },
      };

      const start = Date.now();
      const result = coerceBySchema(input, schema) as JSONValue[];
      const durationMs = Date.now() - start;

      expect(result).toHaveLength(1000);
      expect(result.every((item) => typeof item === "number")).toBe(true);
      if (process.env.VITEST_PERF_CHECK === "1") {
        expect(durationMs).toBeLessThan(100);
      }
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

      const schema: JSONSchema7 = {
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

      const result = coerceBySchema(input, schema) as JSONObject;
      const level1 = result.level1 as JSONObject;
      const level2 = level1.level2 as JSONObject;
      expect(level2.level3).toEqual([1, 2, 3]);
    });
  });
});
