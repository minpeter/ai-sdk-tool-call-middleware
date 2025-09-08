import { describe, expect, it } from "vitest";

// Import the workspace package by name to validate test-time resolution
import * as RXML from "@ai-sdk-tool/rxml";

describe("@ai-sdk-tool/rxml package resolution", () => {
  it("should expose core parser APIs", () => {
    expect(typeof RXML.parse).toBe("function");
    expect(typeof RXML.parseWithoutSchema).toBe("function");
    expect(typeof RXML.parseNode).toBe("function");
    expect(typeof RXML.stringify).toBe("function");
  });

  it("should parse a simple xml string via parseWithoutSchema", () => {
    const xml = "<tool><name>test</name></tool>";
    const results = RXML.parseWithoutSchema(xml);
    expect(Array.isArray(results)).toBe(true);
    // Should contain an object node for <tool>
    expect(results.some((n: any) => typeof n === "object" && n.tagName === "tool")).toBe(true);
  });
});

