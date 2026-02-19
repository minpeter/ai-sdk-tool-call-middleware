import { describe, expect, it } from "vitest";

import {
  filter,
  parseWithoutSchema,
  simplify,
} from "../../../rxml/core/parser";

describe("robust-xml integration", () => {
  describe("TXML feature compatibility", () => {
    it("supports CDATA sections like TXML", () => {
      const xml = "<xml><![CDATA[some data]]></xml>";
      const result = parseWithoutSchema(xml);
      const xmlNode = result[0] as any;
      expect(xmlNode.children[0]).toBe("some data");
    });

    it("supports comments when enabled", () => {
      const xml = "<test><!-- test --></test>";
      const result = parseWithoutSchema(xml, { keepComments: true });
      const testNode = result[0] as any;
      expect(testNode.children).toContain("<!-- test -->");
    });

    it("supports processing instructions", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?><root></root>`;
      const result = parseWithoutSchema(xml);
      expect(result[0]).toMatchObject({
        tagName: "?xml",
        attributes: {
          version: "1.0",
          encoding: "UTF-8",
        },
      });
    });

    it("supports simplify functionality", () => {
      const xml = `<test><cc>one</cc>test<cc f="test"><sub>3</sub>two</cc><dd></dd></test>`;
      const parsed = parseWithoutSchema(xml);
      const simplified = simplify(parsed);

      expect(simplified).toMatchObject({
        test: {
          cc: ["one", { sub: "3", _attributes: { f: "test" } }],
          dd: "",
        },
      });
    });

    it("supports filter functionality", () => {
      const xml = "<test><cc></cc><cc></cc></test>";
      const parsed = parseWithoutSchema(xml);
      const filtered = filter(
        parsed,
        (element) => element.tagName.toLowerCase() === "cc"
      );

      expect(filtered).toHaveLength(2);
      expect(filtered[0].tagName).toBe("cc");
      expect(filtered[1].tagName).toBe("cc");
    });
  });
});
