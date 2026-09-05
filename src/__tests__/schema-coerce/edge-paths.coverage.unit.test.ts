import { describe, expect, it } from "vitest";
import { coerceBySchema } from "../../schema-coerce";

describe("schema coercion remaining edge paths", () => {
  it("covers primitive and wrapper boundaries", () => {
    expect(
      coerceBySchema(1, { type: "array", prefixItems: [{ type: "number" }] })
    ).toEqual([1]);
    expect(coerceBySchema(1, { type: "array" })).toEqual([1]);
    expect(coerceBySchema("x", { type: "array", items: undefined })).toEqual([
      "x",
    ]);
    expect(coerceBySchema({ value: "x" }, { type: "string" })).toBe("x");
    expect(coerceBySchema({ a: "x", b: "y" }, { type: "number" })).toEqual({
      a: "x",
      b: "y",
    });
    expect(
      coerceBySchema({ value: { nested: true } }, { type: "number" })
    ).toEqual({ value: { nested: true } });
    expect(coerceBySchema({ value: "1.5" }, { type: "integer" })).toEqual({
      value: "1.5",
    });
    expect(coerceBySchema({ value: true }, { type: "number" })).toEqual({
      value: true,
    });
    expect(coerceBySchema("x", { type: "boolean" })).toBe("x");
    expect(coerceBySchema("false", { type: "boolean" })).toBe(false);
    expect(coerceBySchema(1, { type: "boolean" })).toBe(1);
  });

  it("covers enum quote, whitespace, and no-match paths", () => {
    const schema = { type: "string", enum: ["alpha", "beta"] };
    expect(coerceBySchema("alpha", schema)).toBe("alpha");
    expect(coerceBySchema('"alpha"', schema)).toBe("alpha");
    expect(coerceBySchema("'gamma'", schema)).toBe("'gamma'");
    expect(coerceBySchema("ab", { type: "string", enum: ["a b"] })).toBe("ab");
    expect(coerceBySchema("a b", { type: "string", enum: ["ab", "a b"] })).toBe(
      "a b"
    );
    expect(coerceBySchema("x", { type: "string", enum: [] })).toBe("x");
    expect(coerceBySchema("q", { type: "string", enum: ["a"] })).toBe("q");
    expect(coerceBySchema("q q", { type: "string", enum: ["a"] })).toBe("q q");
  });

  it("covers null unions and strict allOf recursion", () => {
    expect(coerceBySchema(null, { type: ["string", "null"] })).toBeNull();
    expect(
      coerceBySchema(
        { count: "2" },
        {
          allOf: [
            {
              type: "object",
              properties: { count: { type: "number" } },
              required: ["count"],
              additionalProperties: false,
            },
            true,
          ],
        }
      )
    ).toEqual({ count: 2 });
    expect(
      coerceBySchema("2", { allOf: [{ type: "number" }, { type: "string" }] })
    ).toBe("2");
    expect(coerceBySchema("2", { allOf: "not-an-array", type: "string" })).toBe(
      "2"
    );
  });
});
