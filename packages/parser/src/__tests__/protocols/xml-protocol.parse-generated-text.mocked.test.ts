import { describe, expect, it, vi } from "vitest";

import { morphXmlProtocol } from "../../protocols/morph-xml-protocol";

describe("morphXmlProtocol parseGeneratedText error path via malformed XML", () => {
  it("calls onError and emits original text when parsing fails", () => {
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
    // Use valid outer structure but malformed inner XML that will cause parsing to fail
    const text = "prefix <a><arg>1</arg><unclosed>tag</a> suffix";
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const texts = out
      .filter((c) => c.type === "text")
      .map((t: any) => t.text)
      .join("");
    expect(texts).toContain("<a><arg>1</arg><unclosed>tag</a>");
    expect(onError).toHaveBeenCalled();
  });
});
