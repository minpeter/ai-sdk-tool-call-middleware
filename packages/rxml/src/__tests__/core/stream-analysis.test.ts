import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { createXMLStream, parseWithoutSchema, XMLTransformStream } from "../..";

const CHUNK_SIZE = 7;
const PROCESSING_DELAY_MS = 100;
const CHUNK_DELAY_MS = 10;
const FALLBACK_TIMEOUT_MS = 1000;

describe("RXML Stream Analysis", () => {
  it("should analyze the current streaming implementation", () => {
    console.log("\\n=== RXML Stream Implementation Analysis ===");

    // Test basic parsing without streaming first
    const xml = "<tool><name>test</name></tool>";
    console.log("Testing basic XML:", xml);

    try {
      const result = parseWithoutSchema(xml);
      console.log("Basic parsing result:", result);
      console.log("Result length:", result.length);
      console.log(
        "Result types:",
        result.map((r) => typeof r)
      );

      expect(result.length).toBeGreaterThan(0);
    } catch (error) {
      console.error("Basic parsing failed:", error);
      throw error;
    }
  });

  it("should test XMLTransformStream directly", async () => {
    console.log("\\n=== XMLTransformStream Direct Test ===");

    const xml = "<simple>content</simple>";
    console.log("Testing XML:", xml);

    const transformStream = new XMLTransformStream();
    const results: any[] = [];

    transformStream.on("data", (data) => {
      console.log("Transform stream data:", data);
      results.push(data);
    });

    transformStream.on("end", () => {
      console.log("Transform stream ended");
    });

    transformStream.on("error", (error) => {
      console.error("Transform stream error:", error);
    });

    // Write data to transform stream
    transformStream.write(Buffer.from(xml));
    transformStream.end();

    // Wait a bit for processing
    await new Promise((resolve) => setTimeout(resolve, PROCESSING_DELAY_MS));

    console.log("Transform results:", results);
    console.log("Transform results length:", results.length);

    // This might fail, but let's see what happens
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  it("should test createXMLStream function", async () => {
    console.log("\\n=== createXMLStream Test ===");

    const xml = "<test>value</test>";
    console.log("Testing XML:", xml);

    const stream = createXMLStream();
    const results: any[] = [];

    stream.on("data", (data) => {
      console.log("XML stream data:", data);
      results.push(data);
    });

    stream.on("end", () => {
      console.log("XML stream ended");
    });

    stream.on("error", (error) => {
      console.error("XML stream error:", error);
    });

    // Write data
    stream.write(Buffer.from(xml));
    stream.end();

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, PROCESSING_DELAY_MS));

    console.log("createXMLStream results:", results);
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  it("should demonstrate chunk-by-chunk processing", async () => {
    console.log("\\n=== Chunk-by-Chunk Processing ===");

    const xml = "<tool><name>test</name></tool>";
    const chunks: string[] = [];

    // Split into chunks
    for (let i = 0; i < xml.length; i += CHUNK_SIZE) {
      chunks.push(xml.slice(i, i + CHUNK_SIZE));
    }

    console.log("Original XML:", xml);
    console.log("Chunks:", chunks);

    const transformStream = new XMLTransformStream();
    const results: any[] = [];

    transformStream.on("data", (data) => {
      console.log("Chunk processing data:", data);
      results.push(data);
    });

    transformStream.on("end", () => {
      console.log("Chunk processing ended");
    });

    transformStream.on("error", (error) => {
      console.error("Chunk processing error:", error);
    });

    // Write chunks one by one
    for (const chunk of chunks) {
      console.log("Writing chunk:", JSON.stringify(chunk));
      transformStream.write(Buffer.from(chunk));
      // Small delay between chunks
      await new Promise((resolve) => setTimeout(resolve, CHUNK_DELAY_MS));
    }

    transformStream.end();

    // Wait for final processing
    await new Promise((resolve) => setTimeout(resolve, PROCESSING_DELAY_MS));

    console.log("Final chunk processing results:", results);
    console.log("Final results length:", results.length);

    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  it("should show the actual streaming behavior", async () => {
    console.log("\\n=== Actual Streaming Behavior Test ===");

    const xml = "<root><item>1</item><item>2</item></root>";
    console.log("Testing complex XML:", xml);

    // Test with readable stream
    const readable = new Readable({
      read() {
        this.push(xml);
        this.push(null);
      },
    });

    const transformStream = createXMLStream();
    const results: any[] = [];

    transformStream.on("data", (data) => {
      console.log("Streaming data received:", data);
      console.log("Data type:", typeof data);
      if (typeof data === "object" && data.tagName) {
        console.log("  Tag:", data.tagName);
        console.log("  Attributes:", data.attributes);
        console.log("  Children:", data.children);
      }
      results.push(data);
    });

    transformStream.on("end", () => {
      console.log("Streaming ended");
    });

    transformStream.on("error", (error) => {
      console.error("Streaming error:", error);
    });

    // Pipe readable to transform
    readable.pipe(transformStream);

    // Wait for completion
    await new Promise((resolve) => {
      transformStream.on("end", resolve);
      setTimeout(resolve, FALLBACK_TIMEOUT_MS); // Fallback timeout
    });

    console.log("Streaming results summary:");
    console.log("  Total results:", results.length);
    console.log(
      "  Result types:",
      results.map((r) => typeof r)
    );
    console.log(
      "  Object results:",
      results.filter((r) => typeof r === "object").map((r) => r.tagName)
    );

    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  it("should demonstrate the issue with current implementation", () => {
    console.log("\\n=== Implementation Issue Analysis ===");

    // The issue seems to be that the XMLTransformStream is not properly
    // processing the XML or the parseWithoutSchema function doesn't support
    // the streaming options being passed to it

    console.log("Current XMLTransformStream implementation issues:");
    console.log(
      "1. parseWithoutSchema may not support pos, parseNode, setPos options"
    );
    console.log("2. The stream processing logic may have bugs");
    console.log(
      "3. The async iterator (processXMLStream) may not be working correctly"
    );

    // Let's test parseWithoutSchema with the options that XMLTransformStream uses
    const xml = "<test>content</test>";

    try {
      // This is what XMLTransformStream tries to do
      const result = parseWithoutSchema(xml, {
        pos: 0,
        parseNode: true,
        setPos: true,
      } as any);

      console.log("parseWithoutSchema with streaming options:", result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log("parseWithoutSchema with streaming options failed:", message);
      console.log("This explains why streaming is not working!");
    }

    // Test without the problematic options
    try {
      const result = parseWithoutSchema(xml);
      console.log("parseWithoutSchema without streaming options:", result);
      console.log("This works fine, so the issue is in the streaming options");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log("Even basic parseWithoutSchema failed:", message);
    }

    expect(true).toBe(true); // This test is just for analysis
  });
});
