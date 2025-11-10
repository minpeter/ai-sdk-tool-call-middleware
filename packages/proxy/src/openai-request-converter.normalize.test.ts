import { describe, expect, it } from "vitest";
import { normalizeMessageContent } from "./openai-request-converter.js";

describe("normalizeMessageContent", () => {
  it("handles string content", () => {
    expect(normalizeMessageContent("hi")).toEqual([
      { type: "text", text: "hi" },
    ]);
  });

  it("handles array of strings", () => {
    expect(normalizeMessageContent(["a", "b"])).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);
  });

  it("handles array of text objects", () => {
    expect(normalizeMessageContent([{ text: "x" }, { text: "y" }])).toEqual([
      { type: "text", text: "x" },
      { type: "text", text: "y" },
    ]);
  });

  it("stringifies non-string text values inside parts", () => {
    expect(normalizeMessageContent([{ text: { a: 1 } }])).toEqual([
      { type: "text", text: JSON.stringify({ a: 1 }) },
    ]);
  });

  it("handles object content by stringifying", () => {
    expect(normalizeMessageContent({ a: 1 })).toEqual([
      { type: "text", text: JSON.stringify({ a: 1 }) },
    ]);
  });

  it("handles null/undefined as empty", () => {
    expect(normalizeMessageContent(null as unknown as any)).toEqual([]);
    expect(normalizeMessageContent(undefined as unknown as any)).toEqual([]);
  });

  it("handles primitives by stringifying", () => {
    expect(normalizeMessageContent(123 as unknown as any)).toEqual([
      { type: "text", text: "123" },
    ]);
    expect(normalizeMessageContent(true as unknown as any)).toEqual([
      { type: "text", text: "true" },
    ]);
  });
});
