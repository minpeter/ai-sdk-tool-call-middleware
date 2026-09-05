import { describe, expect, it } from "vitest";
import { parse } from "../../../rxml";

describe("RXML schema document falsy properties", () => {
  it.each([null, false, 0])(
    "preserves root parsing for properties=%j",
    (properties) => {
      expect(
        parse("<root><name>A</name></root>", { type: "object", properties })
      ).toEqual({ root: { name: "A" } });
    }
  );
});
