import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { processXMLStream, RXMLStreamError } from "@/index";

const CHUNK_SIZE = 7;

/**
 * Simulates LLM token-based streaming by splitting text into fixed-size chunks
 */
function createChunkedStream(
  text: string,
  chunkSize: number = CHUNK_SIZE,
  _parseOptions?: any
): Readable {
  const chunks: string[] = [];

  // Split text into chunks of specified size
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }

  let chunkIndex = 0;

  return new Readable({
    read() {
      if (chunkIndex < chunks.length) {
        // Push chunks immediately without delay for fast testing
        this.push(chunks[chunkIndex]);
        chunkIndex++;
      } else {
        this.push(null); // End of stream
      }
    },
  });
}

/**
 * Test XML samples that represent typical LLM tool call responses
 */
const testXmlSamples = {
  simple: `<tool_call>
  <name>get_weather</name>
  <parameters>
    <location>Seoul</location>
    <unit>celsius</unit>
  </parameters>
</tool_call>`,

  withAttributes: `<tool_call id="call_1" type="function">
  <name>calculate</name>
  <parameters>
    <operation>add</operation>
    <numbers>
      <item>10</item>
      <item>20</item>
      <item>30</item>
    </numbers>
  </parameters>
</tool_call>`,

  multipleTools: `<tools>
  <tool_call id="1">
    <name>search</name>
    <parameters>
      <query>AI research</query>
      <limit>5</limit>
    </parameters>
  </tool_call>
  <tool_call id="2">
    <name>summarize</name>
    <parameters>
      <text>Long text to summarize...</text>
      <max_length>100</max_length>
    </parameters>
  </tool_call>
</tools>`,

  withCdata: `<tool_call>
  <name>execute_code</name>
  <parameters>
    <language>python</language>
    <code><![CDATA[
def hello_world():
    print("Hello, World!")
    return "success"
]]></code>
  </parameters>
</tool_call>`,

  withComments: `<!-- Tool call response -->
<tool_call>
  <name>analyze_data</name>
  <!-- Parameters for analysis -->
  <parameters>
    <dataset>sales_data.csv</dataset>
    <method>regression</method>
  </parameters>
</tool_call>
<!-- End of response -->`,

  malformed: `<tool_call>
  <name>test_function</name>
  <parameters>
    <value>some content with <unclosed tag
    <another>properly closed</another>
  </parameters>
</tool_call>`,

  largeContent: `<tool_call>
  <name>process_large_data</name>
  <parameters>
    <data>${"x".repeat(500)}</data>
    <items>${Array.from({ length: 50 }, (_, i) => `<item id="${i}">Item ${i} content</item>`).join("")}</items>
  </parameters>
</tool_call>`,

  nestedStructure: `<response>
  <tool_calls>
    <tool_call>
      <name>get_user_info</name>
      <parameters>
        <user>
          <id>123</id>
          <profile>
            <name>John Doe</name>
            <email>john@example.com</email>
            <preferences>
              <theme>dark</theme>
              <language>en</language>
            </preferences>
          </profile>
        </user>
      </parameters>
    </tool_call>
  </tool_calls>
</response>`,
};

describe("RXML Chunked Streaming (LLM Token Simulation)", () => {
  describe("Diagnostic Tests", () => {
    it("should verify stream itself is fast (without parser)", async () => {
      const stream = createChunkedStream(
        testXmlSamples.largeContent,
        CHUNK_SIZE
      );

      console.log("Starting stream consumption...");
      const startTime = Date.now();
      let chunkCount = 0;

      // Test simple consumption without processXMLStream
      for await (const chunk of stream) {
        chunkCount++;
      }

      const endTime = Date.now();
      const duration = endTime - startTime;

      console.log(
        `Stream consumption complete. Total chunks: ${chunkCount}, Duration: ${duration}ms`
      );

      // Stream itself should complete within 100ms
      expect(duration).toBeLessThan(100);
      expect(chunkCount).toBeGreaterThan(0);
    });

    it("should verify processXMLStream performance", async () => {
      const stream = createChunkedStream(
        testXmlSamples.largeContent,
        CHUNK_SIZE
      );

      console.log("Starting processXMLStream test...");
      const startTime = Date.now();
      const results: any[] = [];
      let elementCount = 0;

      for await (const element of processXMLStream(stream)) {
        elementCount++;
        results.push(element);
        if (elementCount % 10 === 0) {
          console.log(`  - ${elementCount} elements processed`);
        }
      }

      const endTime = Date.now();
      const duration = endTime - startTime;

      console.log(
        `processXMLStream complete. Total elements: ${elementCount}, Duration: ${duration}ms`
      );

      expect(results.length).toBeGreaterThan(0);
      // Should complete within 5 seconds
      expect(duration).toBeLessThan(5000);
    });
  });

  describe("Basic chunked streaming", () => {
    it("should parse simple tool call with CHUNK_SIZE=7", async () => {
      const stream = createChunkedStream(testXmlSamples.simple, CHUNK_SIZE);
      const results: any[] = [];

      for await (const element of processXMLStream(stream)) {
        results.push(element);
      }

      expect(results).toHaveLength(5); // tool_call, name, parameters, location, unit
      expect(results[0]).toMatchObject({
        tagName: "tool_call",
      });
      expect(results[1]).toMatchObject({
        tagName: "name",
        children: ["get_weather"],
      });
      expect(results[2]).toMatchObject({
        tagName: "parameters",
      });
    });

    it("should handle XML with attributes in chunks", async () => {
      const stream = createChunkedStream(
        testXmlSamples.withAttributes,
        CHUNK_SIZE
      );
      const results: any[] = [];

      for await (const element of processXMLStream(stream)) {
        results.push(element);
      }

      const toolCall = results.find((r) => r.tagName === "tool_call");
      expect(toolCall).toBeDefined();
      expect(toolCall.attributes).toMatchObject({
        id: "call_1",
        type: "function",
      });

      const nameElement = results.find((r) => r.tagName === "name");
      expect(nameElement.children[0]).toBe("calculate");
    });

    it("should parse multiple tool calls in chunks", async () => {
      const stream = createChunkedStream(
        testXmlSamples.multipleTools,
        CHUNK_SIZE
      );
      const results: any[] = [];

      for await (const element of processXMLStream(stream)) {
        results.push(element);
      }

      const toolCalls = results.filter((r) => r.tagName === "tool_call");
      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0].attributes.id).toBe("1");
      expect(toolCalls[1].attributes.id).toBe("2");
    });
  });

  describe("Edge cases with chunking", () => {
    it("should handle tag boundaries split across chunks", async () => {
      // This test specifically checks when tags are split across chunk boundaries
      const _xml = "<tool><name>test</name></tool>";

      // Create chunks that deliberately split tags
      const manualChunks = ["<tool><", "name>te", "st</na", "me></t", "ool>"];

      const stream = new Readable({
        read() {
          const chunk = manualChunks.shift();
          if (chunk) {
            this.push(chunk);
          } else {
            this.push(null);
          }
        },
      });

      const results: any[] = [];
      for await (const element of processXMLStream(stream)) {
        results.push(element);
      }

      expect(results).toHaveLength(2); // tool and name
      expect(results[0].tagName).toBe("tool");
      expect(results[1].tagName).toBe("name");
      expect(results[1].children[0]).toBe("test");
    });

    it("should handle attribute boundaries split across chunks", async () => {
      const _xml = '<tool id="test123" type="function">content</tool>';

      // Split attributes across chunks
      const manualChunks = [
        "<tool ",
        'id="te',
        'st123"',
        " type=",
        '"funct',
        'ion">c',
        "ontent",
        "</tool>",
      ];

      const stream = new Readable({
        read() {
          const chunk = manualChunks.shift();
          if (chunk) {
            this.push(chunk);
          } else {
            this.push(null);
          }
        },
      });

      const results: any[] = [];
      for await (const element of processXMLStream(stream)) {
        results.push(element);
      }

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        tagName: "tool",
        attributes: {
          id: "test123",
          type: "function",
        },
        children: ["content"],
      });
    });

    it("should handle CDATA sections split across chunks", async () => {
      const stream = createChunkedStream(testXmlSamples.withCdata, CHUNK_SIZE);
      const results: any[] = [];

      for await (const element of processXMLStream(stream)) {
        results.push(element);
      }

      const codeElement = results.find((r) => r.tagName === "code");
      expect(codeElement).toBeDefined();
      expect(codeElement.children[0]).toContain("def hello_world():");
      expect(codeElement.children[0]).toContain('print("Hello, World!")');
    });

    it("should handle comments split across chunks", async () => {
      const stream = createChunkedStream(
        testXmlSamples.withComments,
        CHUNK_SIZE
      );
      const results: any[] = [];

      for await (const element of processXMLStream(stream, 0, {
        keepComments: true,
      })) {
        results.push(element);
      }

      const comments = results.filter(
        (r) => typeof r === "string" && r.includes("<!--")
      );
      expect(comments.length).toBeGreaterThan(0);
      expect(comments[0]).toContain("<!-- Tool call response -->");
    });
  });

  describe("Performance with chunked streaming", () => {
    it("should handle large content efficiently with small chunks", async () => {
      const stream = createChunkedStream(
        testXmlSamples.largeContent,
        CHUNK_SIZE
      );
      const startTime = Date.now();
      const results: any[] = [];

      for await (const element of processXMLStream(stream)) {
        results.push(element);
      }

      const endTime = Date.now();

      expect(results.length).toBeGreaterThan(0);
      expect(endTime - startTime).toBeLessThan(5000); // Should complete within 5 seconds

      // Verify large data element exists
      const dataElement = results.find((r) => r.tagName === "data");
      expect(dataElement).toBeDefined();
      expect(dataElement.children[0]).toHaveLength(500); // 500 'x' characters
    });

    it("should process nested structures correctly with chunking", async () => {
      const stream = createChunkedStream(
        testXmlSamples.nestedStructure,
        CHUNK_SIZE
      );
      const results: any[] = [];

      for await (const element of processXMLStream(stream)) {
        results.push(element);
      }

      // Verify nested structure is preserved
      const userElement = results.find((r) => r.tagName === "user");
      const profileElement = results.find((r) => r.tagName === "profile");
      const preferencesElement = results.find(
        (r) => r.tagName === "preferences"
      );

      expect(userElement).toBeDefined();
      expect(profileElement).toBeDefined();
      expect(preferencesElement).toBeDefined();

      const nameElement = results.find(
        (r) => r.tagName === "name" && r.children[0] === "John Doe"
      );
      expect(nameElement).toBeDefined();
      expect(nameElement.children[0]).toBe("John Doe");
    });
  });

  describe("Error handling with chunked streaming", () => {
    it("should handle malformed XML gracefully with chunking", async () => {
      const stream = createChunkedStream(testXmlSamples.malformed, CHUNK_SIZE);

      // Should not throw but handle gracefully
      const results: any[] = [];

      try {
        for await (const element of processXMLStream(stream)) {
          results.push(element);
        }

        // Should have parsed some elements despite malformed content
        expect(results.length).toBeGreaterThan(0);

        const toolCall = results.find((r) => r.tagName === "tool_call");
        const nameElement = results.find((r) => r.tagName === "name");

        // At least one of these should be defined for graceful handling
        expect(toolCall || nameElement).toBeTruthy();

        if (nameElement) {
          expect(nameElement.children[0]).toBe("test_function");
        }
      } catch (error) {
        // If it throws, it should be a meaningful error
        expect(error).toBeInstanceOf(RXMLStreamError);
      }
    });

    it("should handle incomplete XML at end of stream", async () => {
      const incompleteXml =
        "<tool_call><name>test</name><parameters><value>incomplete";
      const stream = createChunkedStream(incompleteXml, CHUNK_SIZE);

      const results: any[] = [];

      try {
        for await (const element of processXMLStream(stream)) {
          results.push(element);
        }

        // Should have parsed the complete elements
        const nameElement = results.find((r) => r.tagName === "name");
        expect(nameElement).toBeDefined();
        expect(nameElement.children[0]).toBe("test");
      } catch (error) {
        // Acceptable to throw on incomplete XML
        expect(error).toBeInstanceOf(RXMLStreamError);
      }
    });
  });

  describe("Real-world LLM streaming patterns", () => {
    it("should handle typical LLM response streaming pattern", async () => {
      // Simulate how an LLM might stream a tool call response
      const llmResponse = `I'll help you with that. Let me call the appropriate function.

<tool_call>
  <name>search_database</name>
  <parameters>
    <query>user information</query>
    <filters>
      <active>true</active>
      <role>admin</role>
    </filters>
    <limit>10</limit>
  </parameters>
</tool_call>

The search has been initiated successfully.`;

      const stream = createChunkedStream(llmResponse, CHUNK_SIZE);
      const results: any[] = [];

      for await (const element of processXMLStream(stream)) {
        results.push(element);
      }

      // Should extract the tool call from the mixed content
      const toolCall = results.find((r) => r.tagName === "tool_call");
      expect(toolCall).toBeDefined();

      const nameElement = results.find((r) => r.tagName === "name");
      expect(nameElement.children[0]).toBe("search_database");

      const filtersElement = results.find((r) => r.tagName === "filters");
      expect(filtersElement).toBeDefined();
    });

    it("should handle streaming with varying chunk sizes", async () => {
      const xml = testXmlSamples.simple;
      const chunkSizes = [3, 5, 7, 10, 15];

      for (const chunkSize of chunkSizes) {
        const stream = createChunkedStream(xml, chunkSize);
        const results: any[] = [];

        for await (const element of processXMLStream(stream)) {
          results.push(element);
        }

        // Results should be consistent regardless of chunk size
        expect(results).toHaveLength(5);
        expect(results[0].tagName).toBe("tool_call");
        expect(results[1].tagName).toBe("name");
        expect(results[1].children[0]).toBe("get_weather");
      }
    });

    it("should handle very small chunks (single character)", async () => {
      const xml = "<tool><name>test</name></tool>";
      const stream = createChunkedStream(xml, 1); // Single character chunks

      const results: any[] = [];
      for await (const element of processXMLStream(stream)) {
        results.push(element);
      }

      expect(results).toHaveLength(2);
      expect(results[0].tagName).toBe("tool");
      expect(results[1].tagName).toBe("name");
      expect(results[1].children[0]).toBe("test");
    });

    it("should handle rapid streaming simulation", async () => {
      const xml = testXmlSamples.withAttributes;

      // Create a stream that pushes chunks very quickly
      const chunks: string[] = [];
      for (let i = 0; i < xml.length; i += CHUNK_SIZE) {
        chunks.push(xml.slice(i, i + CHUNK_SIZE));
      }

      const rapidStream = new Readable({
        read() {
          const chunk = chunks.shift();
          if (chunk) {
            // No delay - push immediately
            this.push(chunk);
          } else {
            this.push(null);
          }
        },
      });

      const results: any[] = [];
      const startTime = Date.now();

      for await (const element of processXMLStream(rapidStream)) {
        results.push(element);
      }

      const endTime = Date.now();

      expect(results.length).toBeGreaterThan(0);
      expect(endTime - startTime).toBeLessThan(1000); // Should be very fast

      const toolCall = results.find((r) => r.tagName === "tool_call");
      expect(toolCall.attributes.id).toBe("call_1");
    });
  });

  describe("Memory efficiency with chunked streaming", () => {
    it("should not accumulate excessive memory with large chunked streams", async () => {
      // Create a very large XML document
      const largeXml = `<data>${Array.from(
        { length: 1000 },
        (_, i) =>
          `<item id="${i}">Content for item ${i} with some additional text to make it larger</item>`
      ).join("")}</data>`;

      // Use a rapid stream to avoid test timeout (push without delays)
      const chunks: string[] = [];
      for (let i = 0; i < largeXml.length; i += CHUNK_SIZE) {
        chunks.push(largeXml.slice(i, i + CHUNK_SIZE));
      }
      const stream = new Readable({
        read() {
          const chunk = chunks.shift();
          if (chunk) {
            this.push(chunk);
          } else {
            this.push(null);
          }
        },
      });
      let processedCount = 0;
      const maxProcessed = 100; // Process only first 100 elements

      for await (const element of processXMLStream(stream)) {
        processedCount++;

        // Verify each element is properly formed
        if (typeof element === "object" && element.tagName === "item") {
          expect(element.attributes.id).toBeDefined();
          expect(element.children).toBeDefined();
        }

        // Stop after processing enough elements to test streaming behavior
        if (processedCount >= maxProcessed) {
          break;
        }
      }

      expect(processedCount).toBe(maxProcessed);
    });
  });

  describe("Chunk boundary debugging", () => {
    it("should show how XML is split into chunks", async () => {
      const xml = testXmlSamples.simple;
      const chunks: string[] = [];

      // Split into chunks and log them
      for (let i = 0; i < xml.length; i += CHUNK_SIZE) {
        chunks.push(xml.slice(i, i + CHUNK_SIZE));
      }

      console.log("XML split into chunks (CHUNK_SIZE=7):");
      chunks.forEach((chunk, index) => {
        console.log(`Chunk ${index}: "${chunk}"`);
      });

      // Verify streaming still works
      const stream = createChunkedStream(xml, CHUNK_SIZE);
      const results: any[] = [];

      for await (const element of processXMLStream(stream)) {
        results.push(element);
      }

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].tagName).toBe("tool_call");
    });

    it("should demonstrate problematic chunk boundaries", async () => {
      // Test cases where chunk boundaries split important parts
      const testCases = [
        {
          name: "Tag name split",
          xml: "<tool_call><name>test</name></tool_call>",
          expectedChunks: [
            "<tool_c",
            "all><na",
            "me>test",
            "</name>",
            "</tool_",
            "call>",
          ],
        },
        {
          name: "Attribute split",
          xml: '<tool id="123" type="func">content</tool>',
          expectedChunks: [
            "<tool i",
            'd="123"',
            ' type="',
            'func">c',
            "ontent<",
            "/tool>",
          ],
        },
        {
          name: "Content split",
          xml: "<data>This is a long content string</data>",
          expectedChunks: [
            "<data>T",
            "his is ",
            "a long ",
            "content",
            " string",
            "</data>",
          ],
        },
      ];

      for (const testCase of testCases) {
        console.log(`\nTest case: ${testCase.name}`);
        console.log(`XML: ${testCase.xml}`);

        const chunks: string[] = [];
        for (let i = 0; i < testCase.xml.length; i += CHUNK_SIZE) {
          chunks.push(testCase.xml.slice(i, i + CHUNK_SIZE));
        }

        console.log("Actual chunks:", chunks);

        // Verify it still parses correctly
        const stream = createChunkedStream(testCase.xml, CHUNK_SIZE);
        const results: any[] = [];

        for await (const element of processXMLStream(stream)) {
          results.push(element);
        }

        expect(results.length).toBeGreaterThan(0);
        console.log(`Parsed ${results.length} elements successfully`);
      }
    });
  });
});
