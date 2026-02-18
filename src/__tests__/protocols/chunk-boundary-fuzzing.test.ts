import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { jsonMixProtocol } from "../../core/protocols/json-mix-protocol";
import { morphXmlProtocol } from "../../core/protocols/morph-xml-protocol";
import { qwen3CoderProtocol } from "../../core/protocols/qwen3coder-protocol";
import { createChunkedStream, pipeWithTransformer } from "../test-helpers";

type MorphXmlTools = Parameters<
  ReturnType<typeof morphXmlProtocol>["createStreamParser"]
>[0]["tools"];

function seededRandom(seed: number): () => number {
  let current = seed;
  return () => {
    current = (current * 9301 + 49_297) % 233_280;
    return current / 233_280;
  };
}

function randomChunkSplit(
  text: string,
  minSize = 1,
  maxSize = 10,
  seed = 0
): string[] {
  const random = seededRandom(seed);
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const size = Math.floor(random() * (maxSize - minSize + 1)) + minSize;
    chunks.push(text.slice(i, i + size));
    i += size;
  }
  return chunks;
}

function charByCharSplit(text: string): string[] {
  return text.split("");
}

function extractToolCalls(
  output: LanguageModelV3StreamPart[]
): Array<{ toolName: string; input: unknown }> {
  return output
    .filter(
      (
        c
      ): c is LanguageModelV3StreamPart & {
        type: "tool-call";
        toolName: string;
        input: string;
      } => c.type === "tool-call"
    )
    .map((c) => ({
      toolName: c.toolName,
      input: JSON.parse(c.input),
    }));
}

function extractText(output: LanguageModelV3StreamPart[]): string {
  return output
    .filter(
      (
        c
      ): c is LanguageModelV3StreamPart & {
        type: "text-delta";
        delta: string;
      } => c.type === "text-delta"
    )
    .map((c) => c.delta)
    .join("");
}

describe("Random chunk boundary fuzzing", () => {
  const jsonMixTestCases = [
    {
      name: "simple tool call",
      input:
        '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call>',
      expectedTools: [{ toolName: "get_weather", input: { city: "Seoul" } }],
      expectedText: "",
    },
    {
      name: "tool call with surrounding text",
      input:
        'Let me check. <tool_call>{"name":"search","arguments":{"q":"test"}}</tool_call> Done!',
      expectedTools: [{ toolName: "search", input: { q: "test" } }],
      expectedTextContains: ["Let me check.", "Done!"],
      expectedTextNotContains: ["<tool_call>", "</tool_call>", '"name"'],
    },
    {
      name: "multiple tool calls",
      input:
        '<tool_call>{"name":"a","arguments":{"x":1}}</tool_call> and <tool_call>{"name":"b","arguments":{"y":2}}</tool_call>',
      expectedTools: [
        { toolName: "a", input: { x: 1 } },
        { toolName: "b", input: { y: 2 } },
      ],
    },
  ];

  const xmlTestCases = [
    {
      name: "simple XML tool call",
      input: "<get_weather><city>Tokyo</city></get_weather>",
      expectedTools: [{ toolName: "get_weather", input: { city: "Tokyo" } }],
    },
    {
      name: "XML tool call with multiple params",
      input: "<search><query>hello world</query><limit>10</limit></search>",
      expectedTools: [
        { toolName: "search", input: { query: "hello world", limit: 10 } },
      ],
    },
    {
      name: "XML with surrounding text",
      input: "Checking... <get_weather><city>NYC</city></get_weather> found!",
      expectedTools: [{ toolName: "get_weather", input: { city: "NYC" } }],
      expectedTextContains: ["Checking...", "found!"],
    },
  ];

  const qwen3CoderProtocolTestCases = [
    {
      name: "simple Qwen3CoderToolParser tool call",
      input:
        "<tool_call><function=get_weather><parameter=city>Tokyo</parameter></function></tool_call>",
      expectedTools: [{ toolName: "get_weather", input: { city: "Tokyo" } }],
    },
    {
      name: "Qwen3CoderToolParser tool call missing </function>",
      input:
        "<tool_call><function=get_weather><parameter=city>Tokyo</parameter></tool_call>",
      expectedTools: [{ toolName: "get_weather", input: { city: "Tokyo" } }],
    },
    {
      name: "Qwen3CoderToolParser tool call with multiple params",
      input:
        "<tool_call><function=search><parameter=query>hello world</parameter><parameter=limit>10</parameter></function></tool_call>",
      expectedTools: [
        { toolName: "search", input: { query: "hello world", limit: "10" } },
      ],
    },
    {
      name: "Qwen3CoderToolParser with surrounding text",
      input:
        "Checking... <tool_call><function=get_weather><parameter=city>NYC</parameter></function></tool_call> found!",
      expectedTools: [{ toolName: "get_weather", input: { city: "NYC" } }],
      expectedTextContains: ["Checking...", "found!"],
      expectedTextNotContains: ["<tool_call>", "</tool_call>"],
    },
    {
      name: "Qwen3CoderToolParser multiple tool calls",
      input:
        "<tool_call><function=a><parameter=x>1</parameter></function></tool_call> and <tool_call><function=b><parameter=y>2</parameter></function></tool_call>",
      expectedTools: [
        { toolName: "a", input: { x: "1" } },
        { toolName: "b", input: { y: "2" } },
      ],
      expectedTextContains: [" and "],
      expectedTextNotContains: ["<tool_call>", "</tool_call>"],
    },
    {
      name: "Qwen3CoderToolParser multiple calls inside one tool_call",
      input:
        "<tool_call><function=alpha><parameter=x>1</parameter></function><function=beta><parameter=y>2</parameter><parameter=y>3</parameter></function></tool_call>",
      expectedTools: [
        { toolName: "alpha", input: { x: "1" } },
        { toolName: "beta", input: { y: ["2", "3"] } },
      ],
    },
  ];

  // Run each test case with 50 different random chunk splits
  const FUZZ_ITERATIONS = 50;

  describe("jsonMixProtocol", () => {
    for (const testCase of jsonMixTestCases) {
      describe(testCase.name, () => {
        it.each(
          Array.from({ length: FUZZ_ITERATIONS }, (_, i) => i)
        )("produces consistent results with random split seed %i", async (seed) => {
          const protocol = jsonMixProtocol();
          const transformer = protocol.createStreamParser({ tools: [] });
          const chunks = randomChunkSplit(testCase.input, 1, 8, seed);
          const stream = createChunkedStream(chunks);

          const output = await convertReadableStreamToArray(
            pipeWithTransformer(stream, transformer)
          );

          const tools = extractToolCalls(output);
          expect(tools).toEqual(testCase.expectedTools);

          const text = extractText(output);

          if (testCase.expectedText !== undefined) {
            expect(text.trim()).toBe(testCase.expectedText);
          }

          if (testCase.expectedTextContains) {
            for (const expected of testCase.expectedTextContains) {
              expect(text).toContain(expected);
            }
          }

          if (testCase.expectedTextNotContains) {
            for (const notExpected of testCase.expectedTextNotContains) {
              expect(text).not.toContain(notExpected);
            }
          }
        });
      });
    }
  });

  describe("morphXmlProtocol", () => {
    const tools: MorphXmlTools = [
      {
        type: "function",
        name: "get_weather",
        inputSchema: { type: "object" },
      },
      { type: "function", name: "search", inputSchema: { type: "object" } },
    ];

    for (const testCase of xmlTestCases) {
      describe(testCase.name, () => {
        it.each(
          Array.from({ length: FUZZ_ITERATIONS }, (_, i) => i)
        )("produces consistent results with random split seed %i", async (seed) => {
          const protocol = morphXmlProtocol();
          const transformer = protocol.createStreamParser({ tools });
          const chunks = randomChunkSplit(testCase.input, 1, 8, seed);
          const stream = createChunkedStream(chunks);

          const output = await convertReadableStreamToArray(
            pipeWithTransformer(stream, transformer)
          );

          const parsedTools = extractToolCalls(output);
          expect(parsedTools).toEqual(testCase.expectedTools);

          if (testCase.expectedTextContains) {
            const text = extractText(output);
            for (const expected of testCase.expectedTextContains) {
              expect(text).toContain(expected);
            }
          }
        });
      });
    }
  });

  describe("qwen3CoderProtocol", () => {
    for (const testCase of qwen3CoderProtocolTestCases) {
      describe(testCase.name, () => {
        it.each(
          Array.from({ length: FUZZ_ITERATIONS }, (_, i) => i)
        )("produces consistent results with random split seed %i", async (seed) => {
          const protocol = qwen3CoderProtocol();
          const transformer = protocol.createStreamParser({ tools: [] });
          const chunks = randomChunkSplit(testCase.input, 1, 8, seed);
          const stream = createChunkedStream(chunks);

          const output = await convertReadableStreamToArray(
            pipeWithTransformer(stream, transformer)
          );

          const tools = extractToolCalls(output);
          expect(tools).toEqual(testCase.expectedTools);

          const text = extractText(output);

          if (testCase.expectedTextContains) {
            for (const expected of testCase.expectedTextContains) {
              expect(text).toContain(expected);
            }
          }

          if (testCase.expectedTextNotContains) {
            for (const notExpected of testCase.expectedTextNotContains) {
              expect(text).not.toContain(notExpected);
            }
          }
        });
      });
    }
  });
});

describe("Single-character chunk streaming", () => {
  describe("jsonMixProtocol", () => {
    it("parses tool call when streamed char-by-char", async () => {
      const input =
        '<tool_call>{"name":"test","arguments":{"value":"hello"}}</tool_call>';
      const protocol = jsonMixProtocol();
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
      const protocol = jsonMixProtocol();
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
      const protocol = jsonMixProtocol();
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
    const tools: MorphXmlTools = [
      {
        type: "function",
        name: "get_weather",
        inputSchema: { type: "object" },
      },
      { type: "function", name: "search", inputSchema: { type: "object" } },
    ];

    it("parses XML tool call when streamed char-by-char", async () => {
      const input = "<get_weather><city>Seoul</city></get_weather>";
      const protocol = morphXmlProtocol();
      const transformer = protocol.createStreamParser({ tools });
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
      const transformer = protocol.createStreamParser({ tools });
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

describe("Unicode and special character boundary handling", () => {
  describe("jsonMixProtocol", () => {
    it("handles Korean characters in arguments", async () => {
      const input =
        '<tool_call>{"name":"search","arguments":{"query":"서울 날씨"}}</tool_call>';
      const protocol = jsonMixProtocol();
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
      const protocol = jsonMixProtocol();
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
      const protocol = jsonMixProtocol();
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
      const protocol = jsonMixProtocol();
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
      const protocol = jsonMixProtocol();
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
      const protocol = jsonMixProtocol();
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
    const tools: MorphXmlTools = [
      { type: "function", name: "search", inputSchema: { type: "object" } },
      { type: "function", name: "translate", inputSchema: { type: "object" } },
      { type: "function", name: "react", inputSchema: { type: "object" } },
    ];

    it("handles Korean characters in XML content", async () => {
      const input = "<search><query>서울 맛집 추천</query></search>";
      const protocol = morphXmlProtocol();
      const transformer = protocol.createStreamParser({ tools });
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
      const transformer = protocol.createStreamParser({ tools });
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
      const transformer = protocol.createStreamParser({ tools });
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
