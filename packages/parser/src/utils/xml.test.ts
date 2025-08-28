import { describe, it, expect } from "vitest";
import { XML_TEXT_NODE, extractToolCallInput } from "./xml";

describe("xml utils", () => {
  it("exports XML_TEXT_NODE constant", () => {
    expect(XML_TEXT_NODE).toBe("#text");
  });

  describe("extractToolCallInput", () => {
    it("returns parsed object when input is JSON string", () => {
      const result = extractToolCallInput({ input: '{"a":1, "b":"x"}' } as any);
      expect(result).toEqual({ a: 1, b: "x" });
    });

    it("returns string when input is non-JSON string", () => {
      const result = extractToolCallInput({ input: "not-json" } as any);
      expect(result).toBe("not-json");
    });

    it("returns value when input is non-string (object)", () => {
      const value = { k: 1 };
      const result = extractToolCallInput({ input: value } as any);
      expect(result).toBe(value);
    });

    it("returns undefined when input field missing", () => {
      const result = extractToolCallInput({} as any);
      expect(result).toBeUndefined();
    });

    it("returns undefined for non-object toolCall", () => {
      const resultNull = extractToolCallInput(null as any);
      const resultNum = extractToolCallInput(123 as any);
      expect(resultNull).toBeUndefined();
      expect(resultNum).toBeUndefined();
    });
  });
});
