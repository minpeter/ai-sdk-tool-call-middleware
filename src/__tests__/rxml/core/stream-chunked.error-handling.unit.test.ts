import { describe, expect, it } from "vitest";

import { processXMLStream } from "../../../rxml/core/stream";
import { RXMLStreamError } from "../../../rxml/errors/types";
import {
  CHUNK_SIZE,
  createChunkedStream,
  testXmlSamples,
} from "./stream-chunked.shared";

describe("RXML Chunked Streaming (LLM Token Simulation)", () => {
  describe("Error handling with chunked streaming", () => {
    it("should handle malformed XML gracefully with chunking", async () => {
      const stream = createChunkedStream(testXmlSamples.malformed, CHUNK_SIZE);

      const results: any[] = [];

      try {
        for await (const element of processXMLStream(stream)) {
          results.push(element);
        }

        expect(results.length).toBeGreaterThan(0);

        const toolCall = results.find((r) => r.tagName === "tool_call");
        const nameElement = results.find((r) => r.tagName === "name");

        expect(toolCall || nameElement).toBeTruthy();

        if (nameElement) {
          expect(nameElement.children[0]).toBe("test_function");
        }
      } catch (error) {
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

        const nameElement = results.find((r) => r.tagName === "name");
        expect(nameElement).toBeDefined();
        expect(nameElement.children[0]).toBe("test");
      } catch (error) {
        expect(error).toBeInstanceOf(RXMLStreamError);
      }
    });
  });
});
