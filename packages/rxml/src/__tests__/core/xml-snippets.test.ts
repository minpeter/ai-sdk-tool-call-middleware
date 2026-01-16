import { describe, expect, it } from "vitest";
import { z } from "zod";

import { XMLTokenizer } from "../../core/tokenizer";
import { parse } from "../../parse";

describe("XML snippets coverage", () => {
  describe("1. declaration + DOCTYPE basic", () => {
    it("parses xml declaration and doctype with internal subset", () => {
      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<!DOCTYPE catalog [",
        '  <!ENTITY company "FriendliAI Co.">',
        '  <!ENTITY terms SYSTEM "terms.txt">',
        '  <!NOTATION png SYSTEM "image/png">',
        '  <!NOTATION jpg SYSTEM "image/jpeg">',
        "]>",
        "<catalog/>",
      ].join("");

      const t = new XMLTokenizer(xml);
      const nodes = t.parseChildren();
      // Expect PI first and DOCTYPE preserved as raw string token
      expect(nodes[0]).toMatchObject({ tagName: "?xml" });
      const doctype = nodes.find(
        (n) =>
          typeof n === "string" && (n as string).startsWith("!DOCTYPE catalog")
      );
      expect(doctype).toBeTruthy();
      // Ensure catalog element exists
      const catalog = nodes.find(
        (n) => typeof n === "object" && (n as any).tagName === "catalog"
      );
      expect(catalog).toBeTruthy();
    });
  });

  describe("2. parameter entity for common attrs + root definition (structure only)", () => {
    it("accepts a DOCTYPE with parameter entity and a root element", () => {
      const xml = [
        "<!DOCTYPE catalog [",
        "  <!ENTITY % common-attrs '",
        "    id ID #IMPLIED",
        "    class CDATA #IMPLIED",
        "    lang NMTOKEN #IMPLIED",
        "  '>",
        "  <!ELEMENT catalog (meta, product+)>",
        "]>",
        "<catalog></catalog>",
      ].join("");

      const t = new XMLTokenizer(xml);
      const nodes = t.parseChildren();
      const doctype = nodes.find(
        (n) =>
          typeof n === "string" && (n as string).startsWith("!DOCTYPE catalog")
      );
      expect(doctype).toBeTruthy();
      const catalog = nodes.find(
        (n) => typeof n === "object" && (n as any).tagName === "catalog"
      );
      expect(catalog).toBeTruthy();
    });
  });

  describe("3. metadata elements + entity reference in text", () => {
    it("keeps meta/title/generator and raw entity reference in text", () => {
      const titleNode = new XMLTokenizer(
        "<title>Sample Catalog &company;</title>"
      ).parseNode() as any;
      expect(titleNode.tagName).toBe("title");
      expect(titleNode.children[0]).toContain("Sample Catalog");
      // Entity is left as raw text in our tokenizer
      expect(titleNode.children[0]).toContain("&company;");

      const genNode = new XMLTokenizer(
        "<generator>GPT-5</generator>"
      ).parseNode() as any;
      expect(genNode.tagName).toBe("generator");
      expect(genNode.children[0]).toBe("GPT-5");
    });
  });

  describe("4. product element with attributes and defaults", () => {
    it("parses attributes and child name element", () => {
      const xml = [
        "<!DOCTYPE catalog [",
        "  <!ELEMENT product (name, description, features?)>",
        "]>",
        '<product id="p1" sku="A-001" status="active">',
        "  <name>Premium Widget</name>",
        "</product>",
      ].join("");

      const node = new XMLTokenizer(xml)
        .parseChildren()
        .find((n) => typeof n === "object") as any;
      expect(node.tagName).toBe("product");
      expect(node.attributes.id).toBe("p1");
      expect(node.attributes.sku).toBe("A-001");
      const name = node.children.find(
        (c: any) => typeof c === "object" && c.tagName === "name"
      ) as any;
      expect(name.children[0]).toBe("Premium Widget");
    });
  });

  describe("5. CDATA usage for code/JSON", () => {
    it("keeps CDATA content exactly", () => {
      const xml1 = [
        '<description><![CDATA[\n  {\n    "version": 1,\n    "msg": "<tags are safe>"\n  }\n]]></description>',
      ].join("");
      const n1 = new XMLTokenizer(xml1).parseNode();
      expect(n1.children[0]).toContain('"version"');
      expect(n1.children[0]).toContain("<tags are safe>");

      const xml2 = [
        '<feature><![CDATA[\n  <script>alert("Hello!");</script>\n]]></feature>',
      ].join("");
      const n2 = new XMLTokenizer(xml2).parseNode();
      expect(n2.children[0]).toContain('<script>alert("Hello!");</script>');
    });
  });

  describe("6. media + NOTATION attributes (treated as regular attributes)", () => {
    it("parses EMPTY media with attributes", () => {
      const xml = [
        "<!DOCTYPE root [",
        '  <!NOTATION png SYSTEM "image/png">',
        '  <!NOTATION jpg SYSTEM "image/jpeg">',
        "]>",
        '<media type="image" src="logoPNG" notation="png"/>',
      ].join("");
      const node = new XMLTokenizer(xml)
        .parseChildren()
        .find((n) => typeof n === "object") as any;
      expect(node.tagName).toBe("media");
      expect(node.children).toEqual([]);
      expect(node.attributes.type).toBe("image");
      expect(node.attributes.src).toBe("logoPNG");
      expect(node.attributes.notation).toBe("png");
    });
  });

  describe("7. IDREF-like cross reference treated as plain attributes", () => {
    it("parses related/ref with target attribute", () => {
      const xml = [
        "<!DOCTYPE root [",
        "  <!ELEMENT related (ref+)>",
        "  <!ELEMENT ref EMPTY>",
        "  <!ATTLIST ref target IDREF #REQUIRED>",
        "]>",
        '<related>\n  <ref target="p2"/>\n</related>',
      ].join("");
      const node = new XMLTokenizer(xml)
        .parseChildren()
        .find((n) => typeof n === "object") as any;
      expect(node.tagName).toBe("related");
      const ref = node.children.find(
        (c: any) => typeof c === "object" && c.tagName === "ref"
      ) as any;
      expect(ref).toBeTruthy();
      expect(ref.children).toEqual([]);
      expect(ref.attributes.target).toBe("p2");
    });
  });

  describe("parse() with schema for snippets", () => {
    it("parses catalog with declaration and DOCTYPE (snippet 1)", () => {
      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<!DOCTYPE catalog [",
        '  <!ENTITY company "FriendliAI Co.">',
        '  <!ENTITY terms SYSTEM "terms.txt">',
        '  <!NOTATION png SYSTEM "image/png">',
        '  <!NOTATION jpg SYSTEM "image/jpeg">',
        "]>",
        "<catalog/>",
      ].join("");
      const schema = z.toJSONSchema(
        z.object({
          catalog: z.string().optional(),
        })
      );
      const result = parse(xml, schema) as any;
      expect(result).toHaveProperty("catalog");
      expect(result.catalog).toBe("");
    });

    it("parses meta title and generator (snippet 3)", () => {
      const xml =
        "<meta><title>Sample Catalog &company;</title><generator>GPT-5</generator></meta>";
      const schema = z.toJSONSchema(
        z.object({
          meta: z.object({ title: z.string(), generator: z.string() }),
        })
      );
      const result = parse(xml, schema, { noChildNodes: [] }) as any;
      expect(result.meta.title).toContain("Sample Catalog");
      expect(result.meta.title).toContain("&company;");
      expect(result.meta.generator).toBe("GPT-5");
    });

    it("parses product name content (snippet 4)", () => {
      const xml = [
        "<!DOCTYPE catalog [",
        "  <!ELEMENT product (name, description, features?)>",
        "]>",
        '<product id="p1" sku="A-001" status="active">',
        "  <name>Premium Widget</name>",
        "</product>",
      ].join("");
      const schema = z.toJSONSchema(
        z.object({
          product: z.object({ name: z.string() }),
        })
      );
      const result = parse(xml, schema) as any;
      expect(result.product.name).toBe("Premium Widget");
    });

    it("parses CDATA as raw strings (snippet 5)", () => {
      const xml = [
        '<description><![CDATA[\n  {\n    "version": 1,\n    "msg": "<tags are safe>"\n  }\n]]></description>',
        '<feature><![CDATA[\n  <script>alert("Hello!");</script>\n]]></feature>',
      ].join("");
      const schema = z.toJSONSchema(
        z.object({ description: z.string(), feature: z.string() })
      );
      const result = parse(xml, schema) as any;
      expect(result.description).toContain('"version"');
      expect(result.description).toContain("<tags are safe>");
      expect(result.feature).toContain('<script>alert("Hello!");</script>');
    });

    it("keeps raw inner for related as string (snippet 7)", () => {
      const xml = [
        "<!DOCTYPE root [",
        "  <!ELEMENT related (ref+)",
        "]>",
        '<related>\n  <ref target="p2"/>\n</related>',
      ].join("");
      const schema = z.toJSONSchema(z.object({ related: z.string() }));
      const result = parse(xml, schema) as any;
      expect(result.related).toContain('<ref target="p2"/>');
    });
  });
});
