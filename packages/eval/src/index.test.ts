import { describe, it, expect } from "vitest";
import { sum } from "./index";

describe("sum", () => {
  it("adds two numbers", () => {
    expect(sum(2, 3)).toBe(5);
  });
});
