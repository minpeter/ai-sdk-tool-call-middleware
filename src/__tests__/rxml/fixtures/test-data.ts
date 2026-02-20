/**
 * Test fixtures and data for robust-xml tests
 */
import { z } from "zod";

export const validXmlSamples = {
  simple: "<root><item>test</item></root>",
  withAttributes: '<root id="main"><item type="test">value</item></root>',
  withCdata: "<root><item><![CDATA[<test>content</test>]]></item></root>",
  withComments:
    "<root><!-- comment --><item>test</item><!-- another comment --></root>",
  withProcessingInstruction:
    '<?xml version="1.0" encoding="UTF-8"?><root><item>test</item></root>',
  withDoctype: "<!DOCTYPE root><root><item>test</item></root>",
  selfClosing: "<root><item/><br/></root>",
  withNamespaces:
    '<root xmlns:ns="http://example.com"><ns:item>test</ns:item></root>',
  mixedContent: "<root>text before <item>nested</item> text after</root>",
  emptyElements: "<root><item></item><empty/></root>",
};

export const malformedXmlSamples = {
  unclosedTag: "<root><item>test",
  mismatchedTags: "<root><item>test</different></root>",
  unclosedAttribute: '<root><item attr="unclosed>test</item></root>',
  invalidCharacters: "<root><item>test & invalid</item></root>",
  nestedUnclosed: "<root><item><nested>test</item></root>",
  commentInAttribute: '<root attr="<!-- comment -->">test</root>',
  cdataUnclosed: "<root><![CDATA[unclosed cdata</root>",
};

export const schemaTestCases = {
  stringProperty: {
    xml: "<content>Hello World</content>",
    schema: z.toJSONSchema(
      z.object({
        content: z.string(),
      })
    ),
    expected: { content: "Hello World" },
  },
  numberProperty: {
    xml: "<value>42</value>",
    schema: z.toJSONSchema(
      z.object({
        value: z.number(),
      })
    ),
    expected: { value: 42 },
  },
  booleanProperty: {
    xml: "<flag>true</flag>",
    schema: z.toJSONSchema(
      z.object({
        flag: z.boolean(),
      })
    ),
    expected: { flag: true },
  },
  arrayProperty: {
    xml: "<items><item>1</item><item>2</item><item>3</item></items>",
    schema: z.toJSONSchema(
      z.object({
        items: z.array(z.number()),
      })
    ),
    expected: { items: [1, 2, 3] },
  },
  objectProperty: {
    xml: "<user><name>John</name><age>30</age></user>",
    schema: z.toJSONSchema(
      z.object({
        user: z.object({
          name: z.string(),
          age: z.number(),
        }),
      })
    ),
    expected: { user: { name: "John", age: 30 } },
  },
};

export const duplicateTagSamples = {
  stringDuplicates: "<content>First</content><content>Second</content>",
  arrayDuplicates: "<items><item>1</item></items><items><item>2</item></items>",
  mixedDuplicates: "<data>text</data><data><nested>object</nested></data>",
};
