import { describe, test, expect } from "vitest";
import { getPotentialStartIndex } from "./get-potential-start-index";

describe("getPotentialStartIndex", () => {
  test("returns -1 when no candidate found", () => {
    const s = "no tools here";
    expect(getPotentialStartIndex(s, "<TOOL_CALL>")).toBeNull();
  });

  test("finds index for a valid start pattern", () => {
    const s = "some text\n<TOOL_CALL>{";
    expect(getPotentialStartIndex(s, "<TOOL_CALL>")).toBeGreaterThanOrEqual(0);
  });
});
