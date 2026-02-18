import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseFromStream } from "../../core/stream";
import { RXMLStreamError } from "../../errors/types";

const CHUNK_SIZE = 7;

/**
 * Simulates LLM token-based streaming by splitting text into fixed-size chunks
 */
function createChunkedStream(
  text: string,
  chunkSize: number = CHUNK_SIZE
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
        // Push immediately for testing
        this.push(chunks[chunkIndex]);
        chunkIndex += 1;
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
};

describe("RXML Chunked Streaming (Working Implementation)", () => {
  describe("Basic streaming with parseFromStream", () => {
    it("should parse simple tool call with chunked streaming", async () => {
      const stream = createChunkedStream(testXmlSamples.simple, CHUNK_SIZE);

      console.log("\\n=== Testing Simple Tool Call ===");
      console.log("XML:", testXmlSamples.simple);

      const results = await parseFromStream(stream);

      console.log("Parsed results:", results.length, "elements");
      results.forEach((result, index) => {
        if (typeof result === "object") {
          console.log(
            `  ${index}: <${result.tagName}> with ${Object.keys(result.attributes).length} attributes`
          );
        } else {
          console.log(`  ${index}: "${result}"`);
        }
      });

      expect(results.length).toBeGreaterThan(0);

      // Find the tool_call element
      const toolCall = results.find(
        (r) => typeof r === "object" && r.tagName === "tool_call"
      );
      expect(toolCall).toBeDefined();

      // Find the name element
      const nameElement = results.find(
        (r) => typeof r === "object" && r.tagName === "name"
      );
      expect(nameElement).toBeDefined();
    });

    it("should handle XML with attributes in chunks", async () => {
      const stream = createChunkedStream(
        testXmlSamples.withAttributes,
        CHUNK_SIZE
      );

      console.log("\\n=== Testing XML with Attributes ===");

      const results = await parseFromStream(stream);

      console.log("Results with attributes:", results.length, "elements");

      const toolCall = results.find(
        (r) => typeof r === "object" && r.tagName === "tool_call"
      );
      expect(toolCall).toBeDefined();

      if (toolCall && typeof toolCall === "object") {
        console.log("Tool call attributes:", toolCall.attributes);
        expect(toolCall.attributes.id).toBe("call_1");
        expect(toolCall.attributes.type).toBe("function");
      }
    });

    it("should parse multiple tool calls in chunks", async () => {
      const stream = createChunkedStream(
        testXmlSamples.multipleTools,
        CHUNK_SIZE
      );

      console.log("\\n=== Testing Multiple Tool Calls ===");

      const results = await parseFromStream(stream);

      console.log("Multiple tools results:", results.length, "elements");

      const toolCalls = results.filter(
        (r) => typeof r === "object" && r.tagName === "tool_call"
      );
      console.log("Found tool calls:", toolCalls.length);

      expect(toolCalls.length).toBe(2);

      if (toolCalls.length >= 2) {
        const first = toolCalls[0];
        const second = toolCalls[1];
        if (typeof first === "object" && typeof second === "object") {
          expect(first.attributes.id).toBe("1");
          expect(second.attributes.id).toBe("2");
        }
      }
    });
  });

  describe("Edge cases with chunked streaming", () => {
    it("should handle tag boundaries split across chunks", async () => {
      const xml = "<tool><name>test</name></tool>";

      // Create chunks that deliberately split tags
      const manualChunks = ["<tool><", "name>te", "st</na", "me></t", "ool>"];

      console.log("\\n=== Manual Tag Boundary Test ===");
      console.log("XML:", xml);
      console.log("Manual chunks:", manualChunks);

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

      const results = await parseFromStream(stream);

      console.log("Manual chunking results:", results.length, "elements");

      expect(results.length).toBeGreaterThan(0);

      const toolElement = results.find(
        (r) => typeof r === "object" && r.tagName === "tool"
      );
      const nameElement = results.find(
        (r) => typeof r === "object" && r.tagName === "name"
      );

      expect(toolElement).toBeDefined();
      expect(nameElement).toBeDefined();

      if (nameElement && typeof nameElement === "object") {
        console.log("Name element children:", nameElement.children);
        expect(nameElement.children).toContain("test");
      }
    });

    it("should handle attribute boundaries split across chunks", async () => {
      const xml = '<tool id="test123" type="function">content</tool>';

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

      console.log("\\n=== Attribute Boundary Test ===");
      console.log("XML:", xml);
      console.log("Manual chunks:", manualChunks);

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

      const results = await parseFromStream(stream);

      console.log("Attribute chunking results:", results.length, "elements");

      expect(results.length).toBeGreaterThan(0);

      const toolElement = results.find(
        (r) => typeof r === "object" && r.tagName === "tool"
      );
      expect(toolElement).toBeDefined();

      if (toolElement && typeof toolElement === "object") {
        console.log("Tool attributes:", toolElement.attributes);
        console.log("Tool children:", toolElement.children);

        expect(toolElement.attributes.id).toBe("test123");
        expect(toolElement.attributes.type).toBe("function");
        expect(toolElement.children).toContain("content");
      }
    });
  });

  describe("Performance and stress testing", () => {
    it("should handle varying chunk sizes consistently", async () => {
      const xml = testXmlSamples.simple;
      const chunkSizes = [1, 3, 5, 7, 10, 15, 20];

      console.log("\\n=== Chunk Size Consistency Test ===");

      for (const chunkSize of chunkSizes) {
        console.log(`\\nTesting chunk size: ${chunkSize}`);

        const stream = createChunkedStream(xml, chunkSize);
        const results = await parseFromStream(stream);

        console.log(`  Results: ${results.length} elements`);

        // Results should be consistent regardless of chunk size
        expect(results.length).toBeGreaterThan(0);

        const toolCall = results.find(
          (r) => typeof r === "object" && r.tagName === "tool_call"
        );
        const nameElement = results.find(
          (r) => typeof r === "object" && r.tagName === "name"
        );

        expect(toolCall).toBeDefined();
        expect(nameElement).toBeDefined();

        if (nameElement && typeof nameElement === "object") {
          expect(nameElement.children).toContain("get_weather");
        }
      }

      console.log("✅ All chunk sizes produced consistent results");
    });

    it("should handle very small chunks (single character)", async () => {
      const xml = "<tool><name>test</name></tool>";
      const stream = createChunkedStream(xml, 1); // Single character chunks

      console.log("\\n=== Single Character Chunks Test ===");
      console.log("XML:", xml);
      console.log("Chunk size: 1 character");

      const results = await parseFromStream(stream);

      console.log("Single char results:", results.length, "elements");

      expect(results.length).toBeGreaterThan(0);

      const toolElement = results.find(
        (r) => typeof r === "object" && r.tagName === "tool"
      );
      const nameElement = results.find(
        (r) => typeof r === "object" && r.tagName === "name"
      );

      expect(toolElement).toBeDefined();
      expect(nameElement).toBeDefined();

      if (nameElement && typeof nameElement === "object") {
        expect(nameElement.children).toContain("test");
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

      console.log("\\n=== LLM Response Pattern Test ===");
      console.log("Response length:", llmResponse.length, "characters");

      const stream = createChunkedStream(llmResponse, CHUNK_SIZE);
      const results = await parseFromStream(stream);

      console.log("LLM response results:", results.length, "elements");

      // Should extract the tool call from the mixed content
      const toolCall = results.find(
        (r) => typeof r === "object" && r.tagName === "tool_call"
      );
      expect(toolCall).toBeDefined();

      const nameElement = results.find(
        (r) => typeof r === "object" && r.tagName === "name"
      );
      expect(nameElement).toBeDefined();

      if (nameElement && typeof nameElement === "object") {
        console.log("Extracted function name:", nameElement.children[0]);
        expect(nameElement.children).toContain("search_database");
      }

      const filtersElement = results.find(
        (r) => typeof r === "object" && r.tagName === "filters"
      );
      expect(filtersElement).toBeDefined();

      console.log(
        "✅ Successfully extracted tool call from mixed LLM response"
      );
    });
  });

  describe("Error handling", () => {
    it("should handle stream errors gracefully", async () => {
      const errorStream = new Readable({
        read() {
          this.emit("error", new Error("Stream error"));
        },
      });

      console.log("\\n=== Stream Error Test ===");

      await expect(parseFromStream(errorStream)).rejects.toThrow(
        RXMLStreamError
      );

      console.log("✅ Stream errors handled correctly");
    });

    it("should handle malformed XML gracefully", async () => {
      const malformedXml = `<tool_call>
  <name>test_function</name>
  <parameters>
    <value>some content with <unclosed tag
    <another>properly closed</another>
  </parameters>
</tool_call>`;

      console.log("\\n=== Malformed XML Test ===");
      console.log("Testing malformed XML with unclosed tag");

      const stream = createChunkedStream(malformedXml, CHUNK_SIZE);

      try {
        const results = await parseFromStream(stream);

        console.log("Malformed XML results:", results.length, "elements");

        // Should have parsed some elements despite malformed content
        expect(results.length).toBeGreaterThan(0);

        const toolCall = results.find(
          (r) => typeof r === "object" && r.tagName === "tool_call"
        );
        expect(toolCall).toBeDefined();

        const nameElement = results.find(
          (r) => typeof r === "object" && r.tagName === "name"
        );
        expect(nameElement).toBeDefined();

        if (nameElement && typeof nameElement === "object") {
          expect(nameElement.children).toContain("test_function");
        }

        console.log("✅ Malformed XML handled gracefully");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log("Malformed XML threw error (acceptable):", message);
        expect(error).toBeInstanceOf(RXMLStreamError);
      }
    });
  });
});
