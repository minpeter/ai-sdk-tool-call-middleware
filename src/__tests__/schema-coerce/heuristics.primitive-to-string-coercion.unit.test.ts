import { describe, expect, it } from "vitest";
import type { ToolInputSchema } from "../../schema/tool-input-schema";
import { coerceBySchema } from "../../schema-coerce";

describe("Coercion Heuristic Handling", () => {
  describe("Primitive to string coercion", () => {
    it("coerces booleans into strings when schema expects string", () => {
      const result = coerceBySchema(false, { type: "string" });
      expect(result).toBe("false");
    });

    it("coerces numbers into strings when schema expects string", () => {
      const result = coerceBySchema(42, { type: "string" });
      expect(result).toBe("42");
    });

    it("coerces nested object properties into strings for string-typed keys", () => {
      const input = {
        op: true,
      };

      const schema = {
        type: "object",
        properties: {
          op: { type: "string" },
        },
        required: ["op"],
        additionalProperties: false,
      } satisfies ToolInputSchema;

      const result = coerceBySchema(input, schema);
      expect(result).toEqual({ op: "true" });
    });
  });
});
