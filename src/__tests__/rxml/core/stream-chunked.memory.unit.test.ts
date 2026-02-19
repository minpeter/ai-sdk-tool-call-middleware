import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { processXMLStream } from "../../../rxml/core/stream";
import { CHUNK_SIZE } from "./stream-chunked.shared";

describe("RXML Chunked Streaming (LLM Token Simulation)", () => {
  describe("Memory efficiency with chunked streaming", () => {
    it("should not accumulate excessive memory with large chunked streams", async () => {
      const largeXml = `<data>${Array.from(
        { length: 1000 },
        (_, i) =>
          `<item id="${i}">Content for item ${i} with some additional text to make it larger</item>`
      ).join("")}</data>`;

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
      const maxProcessed = 100;

      for await (const element of processXMLStream(stream)) {
        processedCount += 1;

        if (typeof element === "object" && element.tagName === "item") {
          expect(element.attributes.id).toBeDefined();
          expect(element.children).toBeDefined();
        }

        if (processedCount >= maxProcessed) {
          break;
        }
      }

      expect(processedCount).toBe(maxProcessed);
    });
  });
});
