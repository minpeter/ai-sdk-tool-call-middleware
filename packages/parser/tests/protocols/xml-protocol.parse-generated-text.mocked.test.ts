import { describe, expect, it, vi } from "vitest";

describe("morphXmlProtocol parseGeneratedText error path via mocked XMLParser", () => {
  it("calls onError and emits original text when XMLParser throws", async () => {
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
    const onError = vi.fn();
    const tools = [
      {
        type: "function",
        name: "a",
        description: "",
        inputSchema: { type: "object" },
      },
    ] as any;
    const text = "prefix <a><arg>1</arg></a> suffix";
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const texts = out
      .filter(c => c.type === "text")
      .map((t: any) => t.text)
      .join("");
    expect(texts).toContain("<a><arg>1</arg></a>");
    expect(onError).toHaveBeenCalled();
  });
});
