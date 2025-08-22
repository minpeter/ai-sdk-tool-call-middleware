import { describe, test, expect } from "vitest";
import { parse } from "./relaxed-json";

describe("parseRelaxedJson", () => {
  test("parses JSON with single quotes and trailing commas", () => {
    const input = "{ 'a': 1, 'b': 2, }";
    const res = parse(input);
    expect(res).toEqual({ a: 1, b: 2 });
  });

  test("throws on invalid input", () => {
    expect(() => parse("{ invalid }")).toThrow();
  });
});
