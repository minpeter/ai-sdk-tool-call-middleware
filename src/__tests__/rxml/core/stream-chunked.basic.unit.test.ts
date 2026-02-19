import { describe, expect, it } from "vitest";

import { processXMLStream } from "../../../rxml/core/stream";
import {
  CHUNK_SIZE,
  createChunkedStream,
  testXmlSamples,
} from "./stream-chunked.shared";

describe("RXML Chunked Streaming (LLM Token Simulation)", () => {
  describe("Basic chunked streaming", () => {
    it("should parse simple tool call with CHUNK_SIZE=7", async () => {
      const stream = createChunkedStream(testXmlSamples.simple, CHUNK_SIZE);
      const results: any[] = [];

      for await (const element of processXMLStream(stream)) {
        results.push(element);
      }

      expect(results).toHaveLength(5);
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
});
