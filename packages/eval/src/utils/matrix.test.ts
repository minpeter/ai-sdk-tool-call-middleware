import { describe, it, expect } from "vitest";
import { expandMatrix } from "./matrix";
import type { LanguageModel } from "ai";

describe("expandMatrix", () => {
  it("returns single model combos when no configs", () => {
    const m: LanguageModel = {} as any;
    const out = expandMatrix([m]);
    expect(out).toHaveLength(1);
    expect(out[0].model).toBe(m);
  });

  it("expands with configs", () => {
    const m1: LanguageModel = {} as any;
    const m2: LanguageModel = {} as any;
    const out = expandMatrix([m1, m2], [{ a: 1 }, { a: 2 }]);
    expect(out).toHaveLength(4);
    // each combo should contain one of the models
    const models = out.map(o => o.model);
    expect(models).toEqual(expect.arrayContaining([m1, m2]));
  });
});
