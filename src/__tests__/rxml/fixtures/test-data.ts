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

export const complexXmlSample = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE document [
  <!ENTITY example "test entity">
]>
<document xmlns="http://example.com" xmlns:ext="http://external.com">
  <!-- Document header -->
  <header>
    <title>Test Document</title>
    <author ext:role="primary">John Doe</author>
    <created>2023-01-01T00:00:00Z</created>
  </header>
  
  <body>
    <section id="intro">
      <h1>Introduction</h1>
      <p>This is a <em>test</em> document with <strong>mixed content</strong>.</p>
      <code><![CDATA[
        function test() {
          return "Hello World";
        }
      ]]></code>
    </section>
    
    <section id="data">
      <h1>Data Section</h1>
      <items>
        <item type="string" id="1">First Item</item>
        <item type="number" id="2">42</item>
        <item type="boolean" id="3">true</item>
      </items>
      
      <metadata>
        <tags>
          <tag>xml</tag>
          <tag>parsing</tag>
          <tag>test</tag>
        </tags>
        <stats count="3" processed="true"/>
      </metadata>
    </section>
  </body>
  
  <!-- Document footer -->
  <footer>
    <updated>2023-01-02T12:00:00Z</updated>
  </footer>
</document>`;

export const streamingXmlSample = `<stream>
${Array.from({ length: 1000 }, (_, i) => `  <item id="${i}">Item ${i}</item>`).join("\n")}
</stream>`;

export const errorTestCases = {
  parseError: {
    xml: "<root><unclosed>",
    expectedError: "RXMLParseError",
  },
  coercionError: {
    xml: "<value>not-a-number</value>",
    schema: z.toJSONSchema(
      z.object({
        value: z.number(),
      })
    ),
    expectedError: "RXMLCoercionError",
  },
  duplicateError: {
    xml: "<content>First</content><content>Second</content>",
    schema: z.toJSONSchema(
      z.object({
        content: z.string(),
      })
    ),
    options: { throwOnDuplicateStringTags: true },
    expectedError: "RXMLDuplicateStringTagError",
  },
};
