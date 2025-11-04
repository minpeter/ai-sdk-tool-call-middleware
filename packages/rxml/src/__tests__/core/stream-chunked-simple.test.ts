import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { processXMLStream } from "../..";

const CHUNK_SIZE = 7;

/**
 * Simulates LLM token-based streaming by splitting text into fixed-size chunks
 * Uses synchronous approach for testing
 */
function createSyncChunkedStream(
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
        // Push immediately without delay for testing
        this.push(chunks[chunkIndex]);
        chunkIndex += 1;
      } else {
        this.push(null); // End of stream
      }
    },
  });
}

describe("RXML Chunked Streaming - Simple Tests", () => {
  it("should demonstrate chunk splitting", () => {
    const xml = "<tool_call><name>test</name></tool_call>";
    const chunks: string[] = [];

    for (let i = 0; i < xml.length; i += CHUNK_SIZE) {
      chunks.push(xml.slice(i, i + CHUNK_SIZE));
    }

    console.log("XML:", xml);
    console.log("Chunks:", chunks);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(xml);
  });

  it("should parse simple XML with chunked streaming", async () => {
    const xml = "<tool><name>test</name></tool>";
    console.log("Testing XML:", xml);

    const stream = createSyncChunkedStream(xml, CHUNK_SIZE);
    const results: any[] = [];

    try {
      for await (const element of processXMLStream(stream)) {
        console.log("Received element:", element);
        results.push(element);
      }
    } catch (error) {
      console.error("Error during streaming:", error);
      throw error;
    }

    console.log("Total results:", results.length);
    console.log("Results:", results);

    expect(results.length).toBeGreaterThan(0);
  });

  it("should test RXML stream functionality directly", async () => {
    const xml = "<simple>content</simple>";

    // Test with very simple XML first
    const stream = new Readable({
      read() {
        this.push(xml);
        this.push(null);
      },
    });

    const results: any[] = [];

    try {
      for await (const element of processXMLStream(stream)) {
        results.push(element);
      }
    } catch (error) {
      console.error("Stream error:", error);
      throw error;
    }

    console.log("Simple test results:", results);
    expect(results.length).toBeGreaterThan(0);
  });

  it("should handle manual chunking", async () => {
    const chunks = ["<tool>", "<name>", "test", "</name>", "</tool>"];

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

    const results: any[] = [];

    for await (const element of processXMLStream(stream)) {
      results.push(element);
    }

    console.log("Manual chunking results:", results);
    expect(results.length).toBeGreaterThan(0);
  });
});
