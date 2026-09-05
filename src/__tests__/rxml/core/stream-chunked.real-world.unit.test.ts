import { describe, expect, it } from "vitest";

import {
  CHUNK_SIZE,
  collectStreamElements,
  createChunkedStream,
  createManualChunkStream,
  requireNode,
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

      const results = await collectStreamElements(
        createChunkedStream(llmResponse, CHUNK_SIZE)
      );

      const toolCall = requireNode(
        results.find(
          (element) =>
            typeof element === "object" && element.tagName === "tool_call"
        )
      );
      expect(toolCall).toBeDefined();

      const nameElement = requireNode(
        results.find(
          (element) => typeof element === "object" && element.tagName === "name"
        )
      );
      expect(nameElement.children[0]).toBe("search_database");

      const filtersElement = requireNode(
        results.find(
          (element) =>
            typeof element === "object" && element.tagName === "filters"
        )
      );
      expect(filtersElement).toBeDefined();
    });

    it("should handle streaming with varying chunk sizes", async () => {
      const xml = testXmlSamples.simple;
      const chunkSizes = [3, 5, 7, 10, 15];

      for (const chunkSize of chunkSizes) {
        const results = await collectStreamElements(
          createChunkedStream(xml, chunkSize)
        );

        expect(results).toHaveLength(5);
        const toolCall = requireNode(results[0]);
        const nameElement = requireNode(results[1]);
        expect(toolCall.tagName).toBe("tool_call");
        expect(nameElement.tagName).toBe("name");
        expect(nameElement.children[0]).toBe("get_weather");
      }
    });

    it("should handle very small chunks (single character)", async () => {
      const xml = "<tool><name>test</name></tool>";
      const results = await collectStreamElements(createChunkedStream(xml, 1));

      expect(results).toHaveLength(2);
      const toolElement = requireNode(results.at(0));
      expect(toolElement.tagName).toBe("tool");
      const nameElement = requireNode(results.at(1));
      expect(nameElement.tagName).toBe("name");
      const [nameText] = nameElement.children;
      expect(nameText).toBe("test");
    });

    it("should handle rapid streaming simulation", async () => {
      const xml = testXmlSamples.withAttributes;

      const chunks: string[] = [];
      for (let i = 0; i < xml.length; i += CHUNK_SIZE) {
        chunks.push(xml.slice(i, i + CHUNK_SIZE));
      }

      const rapidStream = createManualChunkStream(chunks);
      const startTime = Date.now();
      const results = await collectStreamElements(rapidStream);
      const endTime = Date.now();

      expect(results.length).toBeGreaterThan(0);
      expect(endTime - startTime).toBeLessThan(1000);

      const toolCall = requireNode(
        results.find(
          (element) =>
            typeof element === "object" && element.tagName === "tool_call"
        )
      );
      expect(toolCall.attributes.id).toBe("call_1");
    });
  });
});
