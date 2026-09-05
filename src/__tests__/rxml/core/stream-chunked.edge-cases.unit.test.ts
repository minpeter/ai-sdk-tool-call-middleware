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
  describe("Edge cases with chunking", () => {
    it("should handle tag boundaries split across chunks", async () => {
      const manualChunks = ["<tool><", "name>te", "st</na", "me></t", "ool>"];
      const results = await collectStreamElements(
        createManualChunkStream(manualChunks)
      );

      expect(results).toHaveLength(2);
      const toolElement = requireNode(results[0]);
      const nameElement = requireNode(results[1]);
      expect(toolElement.tagName).toBe("tool");
      expect(nameElement.tagName).toBe("name");
      expect(nameElement.children[0]).toBe("test");
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

      const results = await collectStreamElements(
        createManualChunkStream(manualChunks)
      );

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
      const results = await collectStreamElements(
        createChunkedStream(testXmlSamples.withCdata, CHUNK_SIZE)
      );

      const codeElement = requireNode(
        results.find(
          (element) => typeof element === "object" && element.tagName === "code"
        )
      );
      expect(codeElement).toBeDefined();
      expect(codeElement.children[0]).toContain("def hello_world():");
      expect(codeElement.children[0]).toContain('print("Hello, World!")');
    });

    it("should handle comments split across chunks", async () => {
      const stream = createChunkedStream(
        testXmlSamples.withComments,
        CHUNK_SIZE
      );
      const results = await collectStreamElements(stream, {
        keepComments: true,
      });

      const comments = results.filter(
        (r) => typeof r === "string" && r.includes("<!--")
      );
      expect(comments.length).toBeGreaterThan(0);
      expect(comments[0]).toContain("<!-- Tool call response -->");
    });
  });
});
