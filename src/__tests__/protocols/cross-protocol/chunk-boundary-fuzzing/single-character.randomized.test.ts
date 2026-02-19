import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";

import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import {
  createChunkedStream,
  pipeWithTransformer,
} from "../../../test-helpers";
import {
  charByCharSplit,
  extractText,
  extractToolCalls,
  morphXmlTools,
} from "./randomized.shared";

describe("Single-character chunk streaming", () => {
  describe("hermesProtocol", () => {
    it("parses tool call when streamed char-by-char", async () => {
      const input =
        '<tool_call>{"name":"test","arguments":{"value":"hello"}}</tool_call>';
      const protocol = hermesProtocol();
      const transformer = protocol.createStreamParser({ tools: [] });
      const chunks = charByCharSplit(input);
      const stream = createChunkedStream(chunks);

      const output = await convertReadableStreamToArray(
        pipeWithTransformer(stream, transformer)
      );

      const tools = extractToolCalls(output);
      expect(tools).toEqual([{ toolName: "test", input: { value: "hello" } }]);
    });

    it("handles text + tool call + text char-by-char", async () => {
      const input =
        'Before <tool_call>{"name":"x","arguments":{}}</tool_call> After';
      const protocol = hermesProtocol();
      const transformer = protocol.createStreamParser({ tools: [] });
      const chunks = charByCharSplit(input);
      const stream = createChunkedStream(chunks);

      const output = await convertReadableStreamToArray(
        pipeWithTransformer(stream, transformer)
      );

      const tools = extractToolCalls(output);
      const text = extractText(output);

      expect(tools).toEqual([{ toolName: "x", input: {} }]);
      expect(text).toContain("Before");
      expect(text).toContain("After");
      expect(text).not.toContain("<tool_call>");
    });

    it("handles multiple tool calls char-by-char", async () => {
      const input =
        '<tool_call>{"name":"a","arguments":{"n":1}}</tool_call><tool_call>{"name":"b","arguments":{"n":2}}</tool_call>';
      const protocol = hermesProtocol();
      const transformer = protocol.createStreamParser({ tools: [] });
      const chunks = charByCharSplit(input);
      const stream = createChunkedStream(chunks);

      const output = await convertReadableStreamToArray(
        pipeWithTransformer(stream, transformer)
      );

      const tools = extractToolCalls(output);
      expect(tools).toEqual([
        { toolName: "a", input: { n: 1 } },
        { toolName: "b", input: { n: 2 } },
      ]);
    });
  });

  describe("morphXmlProtocol", () => {
    it("parses XML tool call when streamed char-by-char", async () => {
      const input = "<get_weather><city>Seoul</city></get_weather>";
      const protocol = morphXmlProtocol();
      const transformer = protocol.createStreamParser({ tools: morphXmlTools });
      const chunks = charByCharSplit(input);
      const stream = createChunkedStream(chunks);

      const output = await convertReadableStreamToArray(
        pipeWithTransformer(stream, transformer)
      );

      const parsedTools = extractToolCalls(output);
      expect(parsedTools).toEqual([
        { toolName: "get_weather", input: { city: "Seoul" } },
      ]);
    });

    it("handles nested params char-by-char", async () => {
      const input =
        "<search><query>test query</query><limit>5</limit><offset>0</offset></search>";
      const protocol = morphXmlProtocol();
      const transformer = protocol.createStreamParser({ tools: morphXmlTools });
      const chunks = charByCharSplit(input);
      const stream = createChunkedStream(chunks);

      const output = await convertReadableStreamToArray(
        pipeWithTransformer(stream, transformer)
      );

      const parsedTools = extractToolCalls(output);
      expect(parsedTools).toEqual([
        {
          toolName: "search",
          input: { query: "test query", limit: 5, offset: 0 },
        },
      ]);
    });
  });

  describe("qwen3CoderProtocol", () => {
    it("parses Qwen3CoderToolParser tool call when streamed char-by-char", async () => {
      const input =
        "<tool_call><function=test><parameter=value>hello</parameter></function></tool_call>";
      const protocol = qwen3CoderProtocol();
      const transformer = protocol.createStreamParser({ tools: [] });
      const chunks = charByCharSplit(input);
      const stream = createChunkedStream(chunks);

      const output = await convertReadableStreamToArray(
        pipeWithTransformer(stream, transformer)
      );

      const tools = extractToolCalls(output);
      expect(tools).toEqual([{ toolName: "test", input: { value: "hello" } }]);
    });

    it("handles text + Qwen3CoderToolParser tool call + text char-by-char", async () => {
      const input =
        "Before <tool_call><function=x><parameter=a>1</parameter></function></tool_call> After";
      const protocol = qwen3CoderProtocol();
      const transformer = protocol.createStreamParser({ tools: [] });
      const chunks = charByCharSplit(input);
      const stream = createChunkedStream(chunks);

      const output = await convertReadableStreamToArray(
        pipeWithTransformer(stream, transformer)
      );

      const tools = extractToolCalls(output);
      const text = extractText(output);

      expect(tools).toEqual([{ toolName: "x", input: { a: "1" } }]);
      expect(text).toContain("Before");
      expect(text).toContain("After");
      expect(text).not.toContain("<tool_call>");
    });

    it("handles multiple Qwen3CoderToolParser tool calls char-by-char", async () => {
      const input =
        "<tool_call><function=a><parameter=n>1</parameter></function></tool_call><tool_call><function=b><parameter=n>2</parameter></function></tool_call>";
      const protocol = qwen3CoderProtocol();
      const transformer = protocol.createStreamParser({ tools: [] });
      const chunks = charByCharSplit(input);
      const stream = createChunkedStream(chunks);

      const output = await convertReadableStreamToArray(
        pipeWithTransformer(stream, transformer)
      );

      const tools = extractToolCalls(output);
      expect(tools).toEqual([
        { toolName: "a", input: { n: "1" } },
        { toolName: "b", input: { n: "2" } },
      ]);
    });
  });
});
