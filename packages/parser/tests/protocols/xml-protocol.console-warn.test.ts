import { describe, expect, it, vi } from "vitest";

import { morphXmlProtocol } from "@/protocols/morph-xml-protocol";

describe("morphXmlProtocol parseGeneratedText without onError", () => {
  it("does not warn to console and returns original text when parsing fails", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      // Intentionally empty - we're mocking to suppress warnings
    });

    const p = morphXmlProtocol();
    // Use malformed XML that will cause parsing to fail
    const text = "<a><x>1</x>"; // Missing closing </a> tag
    const result = p.parseGeneratedText({
      text,
      tools: [{ name: "a" } as any] as any,
      options: undefined as any,
    });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(result).toEqual([{ type: "text", text }]);
    warnSpy.mockRestore();
  });
});
