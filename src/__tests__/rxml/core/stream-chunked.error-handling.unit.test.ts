import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { processXMLStream } from "../../../rxml/core/stream";
import type { RXMLNode } from "../../../rxml/core/types";
import { RXMLStreamError } from "../../../rxml/errors/types";
import {
  CHUNK_SIZE,
  createChunkedStream,
  testXmlSamples,
} from "./stream-chunked.shared";

async function collectStreamElements(
  stream: Readable
): Promise<(RXMLNode | string)[]> {
  const results: (RXMLNode | string)[] = [];
  for await (const element of processXMLStream(stream)) {
    results.push(element);
  }
  return results;
}

function findElement(
  results: readonly (RXMLNode | string)[],
  tagName: string
): RXMLNode | undefined {
  return results.find(
    (result): result is RXMLNode =>
      typeof result !== "string" && result.tagName === tagName
  );
}

describe("RXML Chunked Streaming (LLM Token Simulation)", () => {
  describe("Error handling with chunked streaming", () => {
    it("should handle malformed XML gracefully with chunking", async () => {
      const stream = createChunkedStream(testXmlSamples.malformed, CHUNK_SIZE);

      try {
        const results = await collectStreamElements(stream);

        expect(results.length).toBeGreaterThan(0);

        const toolCall = findElement(results, "tool_call");
        const nameElement = findElement(results, "name");

        expect(toolCall || nameElement).toBeTruthy();

        if (nameElement) {
          expect(nameElement.children[0]).toBe("test_function");
        }
      } catch (error) {
        if (!(error instanceof RXMLStreamError)) {
          throw error;
        }
        expect(error).toBeInstanceOf(RXMLStreamError);
      }
    });

    it("should handle incomplete XML at end of stream", async () => {
      const incompleteXml =
        "<tool_call><name>test</name><parameters><value>incomplete";
      const stream = createChunkedStream(incompleteXml, CHUNK_SIZE);

      try {
        const results = await collectStreamElements(stream);

        const nameElement = findElement(results, "name");
        expect(nameElement).toBeDefined();
        if (nameElement === undefined) {
          throw new TypeError("Expected a name element");
        }
        expect(nameElement.children[0]).toBe("test");
      } catch (error) {
        if (!(error instanceof RXMLStreamError)) {
          throw error;
        }
        expect(error).toBeInstanceOf(RXMLStreamError);
      }
    });
  });
});
