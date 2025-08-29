import { describe, expect, it, vi } from "vitest";

describe("morphXmlProtocol parseGeneratedText without onError", () => {
  it("does not warn to console and returns original text when parsing fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    vi.doMock("fast-xml-parser", () => ({
      XMLParser: class {
        parse() {
          throw new Error("forced parse error");
        }
      },
      XMLBuilder: class {},
    }));
    const { morphXmlProtocol } = await import("@/protocols/morph-xml-protocol");
    const p = morphXmlProtocol();
    const text = "<a><x>1</x></a>";
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
