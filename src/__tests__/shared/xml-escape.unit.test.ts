import { describe, expect, it } from "vitest";
import {
  escapeXml,
  escapeXmlMinimalAttr,
  escapeXmlMinimalText,
  unescapeXml,
} from "../../shared/xml-escape";

describe("shared/xml-escape", () => {
  it("decodes numeric and named entities in a single pass without double-unescaping", () => {
    expect(unescapeXml("&#38;lt;script&#38;gt;")).toBe("&lt;script&gt;");
    expect(unescapeXml("&#x26;lt;")).toBe("&lt;");
    expect(unescapeXml("&amp;lt;")).toBe("&lt;");
    expect(
      unescapeXml("&lt;tag attr=&quot;a&apos;b&quot;&gt;&#65;&#x42;")
    ).toBe('<tag attr="a\'b">AB');
  });

  it("round-trips escaped XML text and attributes", () => {
    const raw = `<a title="x'y">&amp;]]>`;
    expect(unescapeXml(escapeXml(raw))).toBe(raw);
    expect(unescapeXml(escapeXmlMinimalText(raw))).toBe(raw);
    expect(unescapeXml(escapeXmlMinimalAttr(raw, '"'))).toBe(raw);
    expect(unescapeXml(escapeXmlMinimalAttr(raw, "'"))).toBe(raw);
  });
});
