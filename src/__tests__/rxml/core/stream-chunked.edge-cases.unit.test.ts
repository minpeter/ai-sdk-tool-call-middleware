import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { processXMLStream } from "../../../rxml/core/stream";
import {
  CHUNK_SIZE,
  createChunkedStream,
  testXmlSamples,
} from "./stream-chunked.shared";

describe("RXML Chunked Streaming (LLM Token Simulation)", () => {
  describe("Edge cases with chunking", () => {
    it("should handle tag boundaries split across chunks", async () => {
      const manualChunks = ["<tool><", "name>te", "st</na", "me></t", "ool>"];

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

      const results: any[] = [];
      for await (const element of processXMLStream(stream)) {
        results.push(element);
      }

      expect(results).toHaveLength(2);
      expect(results[0].tagName).toBe("tool");
      expect(results[1].tagName).toBe("name");
      expect(results[1].children[0]).toBe("test");
    });

    it("should handle attribute boundaries split across chunks", async () => {
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

      const results: any[] = [];
      for await (const element of processXMLStream(stream)) {
        results.push(element);
      }

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        tagName: "tool",
        attributes: {
          id: "test123",
          type: "function",
        },
        children: ["content"],
      });
    });

    it("should handle CDATA sections split across chunks", async () => {
      const stream = createChunkedStream(testXmlSamples.withCdata, CHUNK_SIZE);
      const results: any[] = [];

      for await (const element of processXMLStream(stream)) {
        results.push(element);
      }

      const codeElement = results.find((r) => r.tagName === "code");
      expect(codeElement).toBeDefined();
      expect(codeElement.children[0]).toContain("def hello_world():");
      expect(codeElement.children[0]).toContain('print("Hello, World!")');
    });

    it("should handle comments split across chunks", async () => {
      const stream = createChunkedStream(
        testXmlSamples.withComments,
        CHUNK_SIZE
      );
      const results: any[] = [];

      for await (const element of processXMLStream(stream, 0, {
        keepComments: true,
      })) {
        results.push(element);
      }

      const comments = results.filter(
        (r) => typeof r === "string" && r.includes("<!--")
      );
      expect(comments.length).toBeGreaterThan(0);
      expect(comments[0]).toContain("<!-- Tool call response -->");
    });
  });
});
