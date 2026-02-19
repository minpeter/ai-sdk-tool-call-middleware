import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";

import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import {
  createChunkedStream,
  pipeWithTransformer,
} from "../../../test-helpers";
import {
  extractToolCalls,
  randomChunkSplit,
  unicodeMorphXmlTools,
} from "./randomized.shared";

describe("Unicode and special character boundary handling", () => {
  describe("hermesProtocol", () => {
    it("handles Korean characters in arguments", async () => {
      const input =
        '<tool_call>{"name":"search","arguments":{"query":"서울 날씨"}}</tool_call>';
      const protocol = hermesProtocol();
      const transformer = protocol.createStreamParser({ tools: [] });

      const chunks = randomChunkSplit(input, 1, 5, 42);
      const stream = createChunkedStream(chunks);

      const output = await convertReadableStreamToArray(
        pipeWithTransformer(stream, transformer)
      );

      const tools = extractToolCalls(output);
      expect(tools).toEqual([
        { toolName: "search", input: { query: "서울 날씨" } },
      ]);
    });

    it("handles Japanese characters in arguments", async () => {
      const input =
        '<tool_call>{"name":"translate","arguments":{"text":"こんにちは世界"}}</tool_call>';
      const protocol = hermesProtocol();
      const transformer = protocol.createStreamParser({ tools: [] });
      const chunks = randomChunkSplit(input, 1, 4, 123);
      const stream = createChunkedStream(chunks);

      const output = await convertReadableStreamToArray(
        pipeWithTransformer(stream, transformer)
      );

      const tools = extractToolCalls(output);
      expect(tools).toEqual([
        { toolName: "translate", input: { text: "こんにちは世界" } },
      ]);
    });

    it("handles emoji in arguments", async () => {
      const input =
        '<tool_call>{"name":"react","arguments":{"emoji":"🎉🚀💻"}}</tool_call>';
      const protocol = hermesProtocol();
      const transformer = protocol.createStreamParser({ tools: [] });
      const chunks = randomChunkSplit(input, 1, 3, 999);
      const stream = createChunkedStream(chunks);

      const output = await convertReadableStreamToArray(
        pipeWithTransformer(stream, transformer)
      );

      const tools = extractToolCalls(output);
      expect(tools).toEqual([
        { toolName: "react", input: { emoji: "🎉🚀💻" } },
      ]);
    });

    it("handles mixed unicode and ASCII", async () => {
      const input =
        '<tool_call>{"name":"search","arguments":{"query":"Hello 世界 🌍 Привет"}}</tool_call>';
      const protocol = hermesProtocol();
      const transformer = protocol.createStreamParser({ tools: [] });
      const chunks = randomChunkSplit(input, 1, 6, 777);
      const stream = createChunkedStream(chunks);

      const output = await convertReadableStreamToArray(
        pipeWithTransformer(stream, transformer)
      );

      const tools = extractToolCalls(output);
      expect(tools).toEqual([
        { toolName: "search", input: { query: "Hello 世界 🌍 Привет" } },
      ]);
    });

    it("handles escaped characters in JSON", async () => {
      const input =
        '<tool_call>{"name":"code","arguments":{"snippet":"function() {\\n  return \\"test\\";\\n}"}}</tool_call>';
      const protocol = hermesProtocol();
      const transformer = protocol.createStreamParser({ tools: [] });
      const chunks = randomChunkSplit(input, 1, 5, 555);
      const stream = createChunkedStream(chunks);

      const output = await convertReadableStreamToArray(
        pipeWithTransformer(stream, transformer)
      );

      const tools = extractToolCalls(output);
      expect(tools).toEqual([
        {
          toolName: "code",
          input: { snippet: 'function() {\n  return "test";\n}' },
        },
      ]);
    });

    it("handles special XML-like characters in JSON strings", async () => {
      const input =
        '<tool_call>{"name":"html","arguments":{"content":"<div class=\\"test\\">Hello</div>"}}</tool_call>';
      const protocol = hermesProtocol();
      const transformer = protocol.createStreamParser({ tools: [] });
      const chunks = randomChunkSplit(input, 1, 4, 333);
      const stream = createChunkedStream(chunks);

      const output = await convertReadableStreamToArray(
        pipeWithTransformer(stream, transformer)
      );

      const tools = extractToolCalls(output);
      expect(tools).toEqual([
        {
          toolName: "html",
          input: { content: '<div class="test">Hello</div>' },
        },
      ]);
    });
  });

  describe("morphXmlProtocol", () => {
    it("handles Korean characters in XML content", async () => {
      const input = "<search><query>서울 맛집 추천</query></search>";
      const protocol = morphXmlProtocol();
      const transformer = protocol.createStreamParser({
        tools: unicodeMorphXmlTools,
      });
      const chunks = randomChunkSplit(input, 1, 4, 42);
      const stream = createChunkedStream(chunks);

      const output = await convertReadableStreamToArray(
        pipeWithTransformer(stream, transformer)
      );

      const parsedTools = extractToolCalls(output);
      expect(parsedTools).toEqual([
        { toolName: "search", input: { query: "서울 맛집 추천" } },
      ]);
    });

    it("handles Chinese characters in XML content", async () => {
      const input = "<translate><text>你好世界</text><to>en</to></translate>";
      const protocol = morphXmlProtocol();
      const transformer = protocol.createStreamParser({
        tools: unicodeMorphXmlTools,
      });
      const chunks = randomChunkSplit(input, 1, 5, 88);
      const stream = createChunkedStream(chunks);

      const output = await convertReadableStreamToArray(
        pipeWithTransformer(stream, transformer)
      );

      const parsedTools = extractToolCalls(output);
      expect(parsedTools).toEqual([
        { toolName: "translate", input: { text: "你好世界", to: "en" } },
      ]);
    });

    it("handles emoji in XML content", async () => {
      const input =
        "<react><type>celebrate</type><emoji>🎊🎉✨</emoji></react>";
      const protocol = morphXmlProtocol();
      const transformer = protocol.createStreamParser({
        tools: unicodeMorphXmlTools,
      });
      const chunks = randomChunkSplit(input, 1, 3, 111);
      const stream = createChunkedStream(chunks);

      const output = await convertReadableStreamToArray(
        pipeWithTransformer(stream, transformer)
      );

      const parsedTools = extractToolCalls(output);
      expect(parsedTools).toEqual([
        { toolName: "react", input: { type: "celebrate", emoji: "🎊🎉✨" } },
      ]);
    });
  });
});
