import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { processXMLStream } from "../../../rxml/core/stream";
import {
  CHUNK_SIZE,
  createChunkedStream,
  testXmlSamples,
} from "./stream-chunked.shared";

describe("RXML Chunked Streaming (LLM Token Simulation)", () => {
  describe("Real-world LLM streaming patterns", () => {
    it("should handle typical LLM response streaming pattern", async () => {
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

        expect(results).toHaveLength(5);
        expect(results[0].tagName).toBe("tool_call");
        expect(results[1].tagName).toBe("name");
        expect(results[1].children[0]).toBe("get_weather");
      }
    });

    it("should handle very small chunks (single character)", async () => {
      const xml = "<tool><name>test</name></tool>";
      const stream = createChunkedStream(xml, 1);

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

      const chunks: string[] = [];
      for (let i = 0; i < xml.length; i += CHUNK_SIZE) {
        chunks.push(xml.slice(i, i + CHUNK_SIZE));
      }

      const rapidStream = new Readable({
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
      const startTime = Date.now();

      for await (const element of processXMLStream(rapidStream)) {
        results.push(element);
      }

      const endTime = Date.now();

      expect(results.length).toBeGreaterThan(0);
      expect(endTime - startTime).toBeLessThan(1000);

      const toolCall = results.find((r) => r.tagName === "tool_call");
      expect(toolCall.attributes.id).toBe("call_1");
    });
  });
});
