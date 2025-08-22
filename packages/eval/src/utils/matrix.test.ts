import { describe, it, expect } from "vitest";
import { expandMatrix } from "./matrix";

describe("expandMatrix", () => {
  it("returns single model combos when no configs", () => {
    const out = expandMatrix([{ name: "m1" }]);
    expect(out).toHaveLength(1);
    expect(out[0].model.name).toBe("m1");
  });

  it("expands with configs", () => {
    const out = expandMatrix(
      [{ name: "m1" }, { name: "m2" }],
      [{ a: 1 }, { a: 2 }]
    );
    expect(out).toHaveLength(4);
    expect(out).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: expect.objectContaining({ name: "m1" }),
        }),
        expect.objectContaining({
          model: expect.objectContaining({ name: "m2" }),
        }),
      ])
    );
  });
});
