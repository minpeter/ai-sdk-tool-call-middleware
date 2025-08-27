import { describe, it, expect, vi } from "vitest";

describe("xmlProtocol console.warn branch", () => {
  it("warns to console when parseGeneratedText fails without onError", async () => {
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
    const { xmlProtocol } = await import("./xml-protocol");
    const p = xmlProtocol();
    const text = "<a><x>1</x></a>";
    void p.parseGeneratedText({
      text,
      tools: [{ name: "a" } as any] as any,
      options: undefined as any,
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
