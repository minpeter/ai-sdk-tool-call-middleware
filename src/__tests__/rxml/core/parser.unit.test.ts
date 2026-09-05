import { isJSONObject, type JSONObject } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { RxmlValue } from "../../../rxml/builders/stringify";
import {
  filter,
  parse,
  parseNode,
  parseWithoutSchema,
  simplify,
} from "../../../rxml/core/parser";
import type { RXMLNode } from "../../../rxml/core/types";
import {
  RXMLDuplicateStringTagError,
  RXMLParseError,
} from "../../../rxml/errors/types";
import {
  duplicateTagSamples,
  malformedXmlSamples,
  schemaTestCases,
  validXmlSamples,
} from "../fixtures/test-data";

const isRXMLNode = (value: RXMLNode | string | undefined): value is RXMLNode =>
  typeof value === "object";

function requireRXMLNode(
  value: RXMLNode | string | undefined,
  failureMessage: string
): RXMLNode {
  if (!isRXMLNode(value)) {
    expect.fail(failureMessage);
  }
  return value;
}

function parseRootWithTwoNodeChildren(
  xml: string
): readonly [RXMLNode, RXMLNode, RXMLNode] {
  const [rootValue] = parseWithoutSchema(xml);
  const root = requireRXMLNode(rootValue, "root was not an XML node");
  const [firstValue, secondValue] = root.children;
  const first = requireRXMLNode(firstValue, "root children were not XML nodes");
  const second = requireRXMLNode(
    secondValue,
    "root children were not XML nodes"
  );
  return [root, first, second];
}

const isRxmlRecord = (
  value: RxmlValue
): value is Readonly<Record<string, RxmlValue>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getFileWrite = (result: JSONObject): JSONObject => {
  const fileWrite = result.file_write;
  if (!isJSONObject(fileWrite) || Array.isArray(fileWrite)) {
    throw new Error("parse result did not contain a file_write object");
  }
  return fileWrite;
};

describe("robust-xml parser", () => {
  describe("parseWithoutSchema", () => {
    it("parses simple XML correctly", () => {
      const result = parseWithoutSchema(validXmlSamples.simple);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        tagName: "root",
        attributes: {},
        children: [
          {
            tagName: "item",
            attributes: {},
            children: ["test"],
          },
        ],
      });
    });

    it("parses XML with attributes", () => {
      const result = parseWithoutSchema(validXmlSamples.withAttributes);
      const root = requireRXMLNode(result[0], "root was not an XML node");
      const child = requireRXMLNode(
        root.children[0],
        "root child was not an XML node"
      );
      expect(root.attributes.id).toBe("main");
      expect(child.attributes.type).toBe("test");
    });

    it("handles CDATA sections", () => {
      const result = parseWithoutSchema(validXmlSamples.withCdata);
      const root = requireRXMLNode(result[0], "root was not an XML node");
      const child = requireRXMLNode(
        root.children[0],
        "root child was not an XML node"
      );
      expect(child.children[0]).toBe("<test>content</test>");
    });

    it("handles comments when keepComments is true", () => {
      const result = parseWithoutSchema(validXmlSamples.withComments, {
        keepComments: true,
      });
      // Comments should be preserved in the structure
      const resultStr = JSON.stringify(result);
      expect(resultStr).toContain("<!-- comment -->");
      expect(resultStr).toContain("<!-- another comment -->");
    });

    it("ignores comments by default", () => {
      const result = parseWithoutSchema(validXmlSamples.withComments);
      const commentNodes = result.filter(
        (node) => typeof node === "string" && node.includes("<!--")
      );
      expect(commentNodes).toHaveLength(0);
    });

    it("handles processing instructions", () => {
      const result = parseWithoutSchema(
        validXmlSamples.withProcessingInstruction
      );
      expect(result[0]).toMatchObject({
        tagName: "?xml",
        attributes: {
          version: "1.0",
          encoding: "UTF-8",
        },
      });
    });

    it("handles DOCTYPE declarations", () => {
      const result = parseWithoutSchema(validXmlSamples.withDoctype);
      expect(result).toContain("!DOCTYPE root");
    });

    it("handles self-closing tags", () => {
      const [root, firstChild, secondChild] = parseRootWithTwoNodeChildren(
        validXmlSamples.selfClosing
      );
      expect(root.children).toHaveLength(2);
      expect(firstChild.children).toHaveLength(0);
      expect(secondChild.children).toHaveLength(0);
    });

    it("preserves whitespace when keepWhitespace is true", () => {
      const xml = "<root>  <item>  test  </item>  </root>";
      const result = parseWithoutSchema(xml, { keepWhitespace: true });
      const [root] = result;
      if (!isRXMLNode(root)) {
        expect.fail("root was not an XML node");
      }
      expect(root.children).toContain("  ");
    });

    it("trims whitespace by default", () => {
      const xml = "<root>  <item>  test  </item>  </root>";
      const result = parseWithoutSchema(xml);
      const [root] = result;
      if (!isRXMLNode(root)) {
        expect.fail("root was not an XML node");
      }
      const textNodes = root.children.filter(
        (child) => typeof child === "string"
      );
      expect(textNodes).toHaveLength(0);
    });
  });

  describe("parseNode", () => {
    it("parses a single node", () => {
      const result = parseNode('<item attr="value">content</item>');
      expect(result).toMatchObject({
        tagName: "item",
        attributes: { attr: "value" },
        children: ["content"],
      });
    });

    it("handles self-closing single node", () => {
      const result = parseNode('<item attr="value"/>');
      expect(result).toMatchObject({
        tagName: "item",
        attributes: { attr: "value" },
        children: [],
      });
    });
  });

  describe("parse with schema", () => {
    it("parses and coerces string properties", () => {
      const result = parse(
        schemaTestCases.stringProperty.xml,
        schemaTestCases.stringProperty.schema
      );
      expect(result).toEqual(schemaTestCases.stringProperty.expected);
    });

    it("parses and coerces number properties", () => {
      const result = parse(
        schemaTestCases.numberProperty.xml,
        schemaTestCases.numberProperty.schema
      );
      expect(result).toEqual(schemaTestCases.numberProperty.expected);
    });

    it("parses and coerces boolean properties", () => {
      const result = parse(
        schemaTestCases.booleanProperty.xml,
        schemaTestCases.booleanProperty.schema
      );
      expect(result).toEqual(schemaTestCases.booleanProperty.expected);
    });

    it("parses and coerces array properties", () => {
      const result = parse(
        schemaTestCases.arrayProperty.xml,
        schemaTestCases.arrayProperty.schema
      );
      expect(result).toEqual(schemaTestCases.arrayProperty.expected);
    });

    it("parses and coerces object properties", () => {
      const result = parse(
        schemaTestCases.objectProperty.xml,
        schemaTestCases.objectProperty.schema
      );
      expect(result).toEqual(schemaTestCases.objectProperty.expected);
    });

    it("handles custom textNodeName", () => {
      const xml = '<value kind="n"> 10.5 </value>';
      const schema = z.toJSONSchema(
        z.object({
          value: z.number(),
        })
      );
      const result = parse(xml, schema, { textNodeName: "_text" });
      expect(result).toEqual({ value: 10.5 });
    });

    it("parses nested string-typed tags without swallowing inner content", () => {
      const xml = "<outer><inner>inside</inner></outer>";
      const schema = z.toJSONSchema(
        z.object({
          outer: z.string(),
          inner: z.string(),
        })
      );

      const result = parse(xml, schema);
      // outer should contain the full raw inner including <inner>...</inner>
      expect(result.outer).toContain("<inner>inside</inner>");
      // inner should be parsed as its own string value
      expect(result.inner).toBe("inside");
    });

    it("handles angle brackets in string content within nested object schema", () => {
      const xml = `<file_write>\n<path>\ntest.c\n</path>\n<content>\n#include <stdio.h>\n\nint main() {\n  printf("Hello, world!\\n");\n  return 0;\n}\n</content>\n</file_write>`;
      const schema = z.toJSONSchema(
        z.object({
          file_write: z.object({
            path: z.string(),
            content: z.string(),
          }),
        })
      );

      const result = parse(xml, schema);
      const fileWrite = getFileWrite(result);
      expect(fileWrite).toBeDefined();
      expect(fileWrite.path).toContain("test.c");
      // Should preserve the raw content including angle brackets without treating <stdio.h> as a tag
      expect(fileWrite.content).toContain("#include <stdio.h>");
      expect(fileWrite.content).toContain("int main() {");
    });

    it("parses file_write content across multiple languages using zod schema", () => {
      const schema = z.toJSONSchema(
        z.object({
          file_write: z.object({
            path: z.string(),
            content: z.string(),
          }),
        })
      );

      const snippets: Array<{ path: string; content: string[] }> = [
        {
          path: "test.c",
          content: [
            "#include <stdio.h>",
            "int main() {",
            '  printf("Hello, world!\\n");',
            "  return 0;",
            "}",
          ],
        },
        {
          path: "test.py",
          content: [
            "import os",
            "def write_file(path, content):",
            "  with open(path, 'w') as f:",
            "    f.write(content)",
            "  if f.closed:",
            "    return 'success'",
            "  else:",
            "    return 'error'",
            "",
            "write_file('test.py', \"print('Hello, world!')\\nreturn 'success'\")",
            "print('Hello, world!')",
            "",
            "return 'success'",
          ],
        },
        {
          path: "test.js",
          content: [
            "function greet(name) {",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: This is test data containing a template literal
            "  console.log(`Hello, ${name}!`);",
            "}",
            "greet('world');",
          ],
        },
        {
          path: "test.ts",
          content: [
            "type User = { name: string; age: number };",
            "const user: User = { name: 'John', age: 30 };",
            "console.log(user.name.toUpperCase());",
          ],
        },
        {
          path: "test.java",
          content: [
            "public class Main {",
            "  public static void main(String[] args) {",
            '    System.out.println("Hello, world!");',
            "  }",
            "}",
          ],
        },
        {
          path: "test.go",
          content: [
            "package main",
            'import "fmt"',
            "func main() {",
            '  fmt.Println("Hello, world!")',
            "}",
          ],
        },
        {
          path: "test.rs",
          content: ["fn main() {", '    println!("Hello, world!");', "}"],
        },
        {
          path: "test.rb",
          content: [
            "def greet(name)",
            '  puts "Hello, #{name}!"',
            "end",
            "greet('world')",
          ],
        },
        {
          path: "test.php",
          content: ["<?php", "echo 'Hello, world!';", "?>"],
        },
        {
          path: "test.sh",
          content: ["#!/usr/bin/env bash", 'echo "Hello, world!"'],
        },
        {
          path: "test.yaml",
          content: ["name: example", "values:", "  - one", "  - two"],
        },
        {
          path: "test.json",
          content: ["{", '  "name": "example",', '  "value": 1', "}"],
        },
        {
          path: "test.html",
          content: [
            "<!doctype html>",
            "<html>",
            "  <head><title>Hello</title></head>",
            "  <body><h1>Hello</h1></body>",
            "</html>",
          ],
        },
        {
          path: "test.sql",
          content: [
            "CREATE TABLE users (id INT PRIMARY KEY, name TEXT);",
            "INSERT INTO users (id, name) VALUES (1, 'John');",
            "SELECT * FROM users;",
          ],
        },
        {
          path: "test.scala",
          content: [
            "object Main extends App {",
            '  println("Hello, world!")',
            "}",
          ],
        },
        {
          path: "test.kt",
          content: ["fun main() {", '  println("Hello, world!")', "}"],
        },
      ];

      for (const { path, content } of snippets) {
        const xml = [
          "<file_write>",
          `<path>${path}</path>`,
          "<content>",
          content.join("\n"),
          "</content>",
          "</file_write>",
        ].join("\n");

        const result = parse(xml, schema);
        const fileWrite = getFileWrite(result);
        expect(fileWrite).toBeDefined();
        expect(fileWrite.path).toBe(path);
        for (const line of content) {
          expect(fileWrite.content).toContain(line);
        }
      }
    });
  });

  describe("duplicate tag handling", () => {
    it("throws RXMLDuplicateStringTagError for duplicate string tags by default", () => {
      const schema = {
        type: "object",
        properties: { content: { type: "string" } },
      };
      expect(() => parse(duplicateTagSamples.stringDuplicates, schema)).toThrow(
        RXMLDuplicateStringTagError
      );
    });

    it("handles duplicates gracefully when throwOnDuplicateStringTags is false", () => {
      const schema = {
        type: "object",
        properties: { content: { type: "string" } },
      };
      const result = parse(duplicateTagSamples.stringDuplicates, schema, {
        throwOnDuplicateStringTags: false,
      });
      expect(result.content).toBe("First"); // Should use first occurrence
    });
  });

  describe("error handling", () => {
    it("handles malformed XML gracefully", () => {
      expect(() => parseWithoutSchema(malformedXmlSamples.unclosedTag)).toThrow(
        RXMLParseError
      );
    });

    it("throws RXMLParseError for mismatched tags", () => {
      expect(() =>
        parseWithoutSchema(malformedXmlSamples.mismatchedTags)
      ).toThrow(RXMLParseError);
    });

    it("handles unclosed attributes gracefully", () => {
      // Should not throw, but handle gracefully
      const result = parseWithoutSchema(malformedXmlSamples.unclosedAttribute);
      expect(result).toBeDefined();
    });
  });

  describe("simplify", () => {
    it("simplifies parsed XML structure", () => {
      const parsed = parseWithoutSchema("<test><cc>one</cc><dd></dd></test>");
      const simplified = simplify(parsed);
      expect(simplified).toMatchObject({
        test: {
          cc: "one",
          dd: "",
        },
      });
    });

    it("handles arrays in simplification", () => {
      const parsed = parseWithoutSchema(
        "<test><cc>one</cc><cc>two</cc></test>"
      );
      const simplified = simplify(parsed);
      if (isRxmlRecord(simplified) && isRxmlRecord(simplified.test)) {
        const { cc } = simplified.test;
        expect(cc).toEqual(["one", "two"]);
      } else {
        expect.fail("simplified result was not an object with 'test'");
      }
    });

    it("preserves attributes in simplification", () => {
      const parsed = parseWithoutSchema(
        '<test><cc attr="value">content</cc></test>'
      );
      const simplified = simplify(parsed);
      if (isRxmlRecord(simplified) && isRxmlRecord(simplified.test)) {
        const { cc } = simplified.test;
        if (isRxmlRecord(cc)) {
          expect(cc._attributes).toEqual({ attr: "value" });
        } else {
          expect.fail("cc was not an object on simplified.test");
        }
      } else {
        expect.fail("simplified result was not an object with 'test'");
      }
    });
  });

  describe("filter", () => {
    it("filters nodes based on predicate", () => {
      const parsed = parseWithoutSchema(
        '<root><item id="1">first</item><item id="2">second</item><other>test</other></root>'
      );
      const filtered = filter(parsed, (node) => node.tagName === "item");
      expect(filtered).toHaveLength(2);
      expect(filtered[0].tagName).toBe("item");
      expect(filtered[1].tagName).toBe("item");
    });

    it("filters with complex predicates", () => {
      const parsed = parseWithoutSchema(
        '<root><item type="a">first</item><item type="b">second</item></root>'
      );
      const filtered = filter(parsed, (node) => node.attributes.type === "a");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].attributes.type).toBe("a");
    });
  });

  describe("edge cases", () => {
    it("handles empty XML", () => {
      const result = parseWithoutSchema("");
      expect(result).toEqual([]);
    });

    it("handles XML with only whitespace", () => {
      const result = parseWithoutSchema("   \n  \t  ");
      expect(result).toEqual([]);
    });

    it("handles mixed content correctly", () => {
      const result = parseWithoutSchema(validXmlSamples.mixedContent);
      const [root] = result;
      if (!isRXMLNode(root)) {
        expect.fail("root was not an XML node");
      }
      expect(root.children).toHaveLength(3); // "text before ", item element, " text after"
      expect(root.children[0]).toBe("text before");
      expect(root.children[2]).toBe("text after");
    });

    it("handles nested empty elements", () => {
      const [root, firstChild, secondChild] = parseRootWithTwoNodeChildren(
        validXmlSamples.emptyElements
      );
      expect(root.children).toHaveLength(2);
      expect(firstChild.children).toEqual([]);
      expect(secondChild.children).toEqual([]);
    });
  });
});
