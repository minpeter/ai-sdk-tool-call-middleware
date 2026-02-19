import { describe, expect, it } from "vitest";

import { processXMLStream } from "../../../rxml/core/stream";
import {
  CHUNK_SIZE,
  createChunkedStream,
  testXmlSamples,
} from "./stream-chunked.shared";

describe("RXML Chunked Streaming (LLM Token Simulation)", () => {
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
      expect(endTime - startTime).toBeLessThan(5000);

      const dataElement = results.find((r) => r.tagName === "data");
      expect(dataElement).toBeDefined();
      expect(dataElement.children[0]).toHaveLength(500);
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
});
