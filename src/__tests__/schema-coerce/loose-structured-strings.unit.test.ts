import { describe, expect, it } from "vitest";

import { coerceBySchema } from "../../schema-coerce";

// Live-model variants: nested object parameters delivered as strings
// (JSON, Python-literal dicts, XML children) instead of structured values.
const schema = {
  type: "object",
  properties: {
    passenger: {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
        frequentFlyer: { type: "boolean" },
      },
    },
    legs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
        },
      },
    },
  },
};

describe("coerceBySchema loose structured strings", () => {
  it("parses single-quoted Python-literal dict strings (KAT Coder shape)", () => {
    const out = coerceBySchema(
      {
        passenger: "{'name': 'Jane Doe', 'age': 34, 'frequentFlyer': True}",
      },
      schema
    ) as Record<string, unknown>;

    expect(out.passenger).toEqual({
      name: "Jane Doe",
      age: 34,
      frequentFlyer: true,
    });
  });

  it("parses Python-literal list strings for array-typed parameters", () => {
    const out = coerceBySchema(
      { legs: "[{'from': 'ICN', 'to': 'NRT'}]" },
      schema
    ) as Record<string, unknown>;

    expect(out.legs).toEqual([{ from: "ICN", to: "NRT" }]);
  });

  it("parses XML-children strings for object-typed parameters (Command R+ shape)", () => {
    const out = coerceBySchema(
      { passenger: "<name>Jane Doe</name>\n<age>34</age>" },
      schema
    ) as Record<string, unknown>;

    expect(out.passenger).toEqual({ name: "Jane Doe", age: 34 });
  });

  it("rejects prototype-sensitive keys in loose strings", () => {
    const out = coerceBySchema(
      { passenger: "{'__proto__': {'polluted': True}}" },
      schema
    ) as Record<string, unknown>;

    // Not coerced into an object — the raw string is preserved.
    expect(typeof out.passenger).toBe("string");
  });

  it("rejects unicode-escaped prototype-sensitive keys after strict JSON parse", () => {
    const out = coerceBySchema(
      {
        passenger:
          '{"\\u005f\\u005fproto\\u005f\\u005f":{"polluted":true},"name":"Jane Doe"}',
      },
      schema
    ) as Record<string, unknown>;

    expect(typeof out.passenger).toBe("string");
  });

  it("keeps CSV splitting for plain enumerations", () => {
    const out = coerceBySchema(
      { tags: "a, b, c" },
      {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" } },
        },
      }
    ) as Record<string, unknown>;

    expect(out.tags).toEqual(["a", "b", "c"]);
  });
});

describe("coerceBySchema Python literal handling (review fixes)", () => {
  it("converts bare None to null instead of the string 'None'", () => {
    const out = coerceBySchema(
      { passenger: "{'name': None, 'age': 34}" },
      schema
    ) as Record<string, unknown>;

    expect(out.passenger).toEqual({ name: null, age: 34 });
  });

  it("never rewrites Python literals inside string values", () => {
    const out = coerceBySchema(
      { passenger: "{'name': 'True story of None', 'age': 34}" },
      schema
    ) as Record<string, unknown>;

    expect(out.passenger).toEqual({ name: "True story of None", age: 34 });
  });

  it("unescapes XML entities in XML-children strings", () => {
    const out = coerceBySchema(
      { passenger: "<name>Tom &amp; Jerry</name>\n<age>34</age>" },
      schema
    ) as Record<string, unknown>;

    expect(out.passenger).toEqual({ name: "Tom & Jerry", age: 34 });
  });
});
