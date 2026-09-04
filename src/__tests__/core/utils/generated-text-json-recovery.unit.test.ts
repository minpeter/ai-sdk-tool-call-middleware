import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4ToolCall,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { isRecord } from "../../../core/utils/generated-text-json-candidates";
import {
  recoverToolCallFromJsonCandidates,
  recoverToolCallFromJsonCandidatesWithStatus,
} from "../../../core/utils/generated-text-json-recovery";

function findToolCall(
  content: LanguageModelV4Content[] | null | undefined
): LanguageModelV4ToolCall {
  const call = content?.find((part) => part.type === "tool-call");
  if (call?.type !== "tool-call") {
    throw new Error("Expected a recovered tool call");
  }
  return call;
}

function findToolCalls(
  content: LanguageModelV4Content[] | null | undefined
): LanguageModelV4ToolCall[] {
  if (!content) {
    throw new Error("Expected recovered content");
  }
  return content.filter((part) => part.type === "tool-call");
}

function recoveredText(
  content: LanguageModelV4Content[] | null | undefined
): string {
  return (content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function recoverCall(
  text: string,
  toolDefinitions: LanguageModelV4FunctionTool[] = tools
): LanguageModelV4ToolCall {
  return findToolCall(recoverToolCallFromJsonCandidates(text, toolDefinitions));
}

function expectCall(
  text: string,
  expectedToolName: string,
  expectedInput: object,
  toolDefinitions: LanguageModelV4FunctionTool[] = tools
): void {
  const call = recoverCall(text, toolDefinitions);
  expect(call.toolName).toBe(expectedToolName);
  expect(JSON.parse(call.input)).toEqual(expectedInput);
}

function expectCallCountWithoutText(text: string, count: number): void {
  const recovered = recoverToolCallFromJsonCandidates(text, tools);
  expect(findToolCalls(recovered)).toHaveLength(count);
  expect(recovered?.some((part) => part.type === "text")).toBe(false);
}

describe("isRecord", () => {
  it("rejects null and array values", () => {
    expect([isRecord(null), isRecord([])]).toEqual([false, false]);
  });

  it("accepts plain and null-prototype records", () => {
    const nullPrototypeRecord = Object.setPrototypeOf({ value: 1 }, null);

    expect([isRecord({ value: 1 }), isRecord(nullPrototypeRecord)]).toEqual([
      true,
      true,
    ]);
  });

  it("rejects records with a custom prototype", () => {
    const inheritedRecord = Object.setPrototypeOf(
      { value: 1 },
      { inherited: true }
    );

    expect(isRecord(inheritedRecord)).toBe(false);
  });
});

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "calc",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number" },
      },
    },
  },
  {
    type: "function",
    name: "get_weather",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string" },
      },
    },
  },
];

describe("recoverToolCallFromJsonCandidates", () => {
  it("ignores null tagged and fenced candidates", () => {
    const recover = () =>
      recoverToolCallFromJsonCandidates(
        "<tool_call>null</tool_call>\n```json\nnull\n```",
        tools,
        () => {
          throw new Error("resolver should not run");
        }
      );

    expect(recover).not.toThrow();
    expect(recover()).toBeNull();
  });

  it("recovers every resolvable JSON candidate in order", () => {
    const text =
      'before {"name":"calc","arguments":{"a":1}} middle\n' +
      "```json\n" +
      '{"name":"calc","arguments":{"a":2}}\n' +
      "``` after";

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    expect(recovered).not.toBeNull();
    const calls = findToolCalls(recovered);

    expect(calls).toHaveLength(2);
    expect(calls[0].toolName).toBe("calc");
    expect(JSON.parse(calls[0].input)).toEqual({ a: 1 });
    expect(JSON.parse(calls[1].input)).toEqual({ a: 2 });

    const textOut = recoveredText(recovered);
    expect(textOut).toContain("before ");
    expect(textOut).toContain(" middle");
    expect(textOut).toContain(" after");
  });

  it("recovers consecutive bare JSON tool payloads as multiple calls", () => {
    // Real-world shape observed from GLM-4.7: parallel calls emitted as
    // newline-separated bare JSON objects, or separated by orphan
    // <tool_call> tags.
    const text =
      '{"name":"get_weather","arguments":{"city":"Seoul"}}\n' +
      '{"name":"get_weather","arguments":{"city":"Tokyo"}}\n' +
      '{"name":"get_weather","arguments":{"city":"Paris"}}';

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    const calls = findToolCalls(recovered);
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => JSON.parse(c.input).city)).toEqual([
      "Seoul",
      "Tokyo",
      "Paris",
    ]);
    expect(recovered?.some((part) => part.type === "text")).toBe(false);
  });

  it("treats orphan tool_call separators between payloads as markup", () => {
    const text =
      '{"name":"get_weather","arguments":{"city":"Seoul"}}<tool_call>{"name":"get_weather","arguments":{"city":"Tokyo"}}';

    expectCallCountWithoutText(text, 2);
  });

  it("does not recover nested tool payload objects", () => {
    const text =
      'before {"tool":{"name":"get_weather","arguments":{"city":"NYC"}}} after';

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    expect(recovered).toBeNull();
  });

  it("recovers tool calls even if stray braces appear before JSON", () => {
    const text = '} prefix {"name":"calc","arguments":{"a":3}} suffix';

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    expect(recovered).not.toBeNull();
    const tool = findToolCall(recovered);

    expect(tool.toolName).toBe("calc");
    expect(JSON.parse(tool.input)).toEqual({ a: 3 });

    const textOut = recoveredText(recovered);
    expect(textOut).toContain("} prefix ");
    expect(textOut).toContain(" suffix");
  });

  it("recovers arguments-only payloads when a single tool is available", () => {
    expectCall(
      '{"city":"Seoul"}',
      "get_weather",
      { city: "Seoul" },
      tools.slice(1, 2)
    );
  });

  it("recovers arguments-only payloads after dropping schema-unknown keys", () => {
    const text = '{"city":"Seoul","mood":"sunny"}';

    const recovered = recoverToolCallFromJsonCandidates(text, [
      {
        ...tools[1],
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    ]);

    const tool = findToolCall(recovered);
    expect(tool.toolName).toBe("get_weather");
    expect(JSON.parse(tool.input)).toEqual({ city: "Seoul" });
  });

  it("does not recover arguments-only payloads when multiple tools exist", () => {
    const text = '{"city":"Seoul"}';

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    expect(recovered).toBeNull();
  });
});

describe("recoverToolCallFromJsonCandidates orphan markup trim", () => {
  it("strips dangling tool_call tags around the recovered payload", () => {
    const text =
      '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</think>';

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    expect(recovered).not.toBeNull();
    const tool = findToolCall(recovered);
    expect(tool.toolName).toBe("get_weather");

    const textOut = recoveredText(recovered);
    expect(textOut).not.toContain("<tool_call>");
  });

  it("strips a dangling close tag after the recovered payload", () => {
    const text = '{"name":"calc","arguments":{"a":1}}</tool_call>';

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    expect(recovered).not.toBeNull();
    const textOut = recoveredText(recovered);
    expect(textOut ?? "").not.toContain("</tool_call>");
  });

  it("keeps surrounding prose intact while trimming orphan tags", () => {
    const text = 'Sure thing:\n<tool_call>{"name":"calc","arguments":{"a":2}}';

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    expect(recovered).not.toBeNull();
    const textOut = recoveredText(recovered);
    expect(textOut).toContain("Sure thing:");
    expect(textOut).not.toContain("<tool_call>");
  });
});

describe("recoverToolCallFromJsonCandidates prototype-sensitive keys", () => {
  const rejectCases = [
    {
      name: "rejects payloads whose arguments contain __proto__",
      text: '{"name":"calc","arguments":{"__proto__":{"x":1}}}',
      toolDefinitions: tools,
    },
    {
      name: "rejects unicode-escaped __proto__ envelopes that inherit tool names",
      text: '{"\\u005f\\u005fproto\\u005f\\u005f":{"name":"calc"},"arguments":{"a":1}}',
      toolDefinitions: tools,
    },
    {
      name: "rejects arguments-only payloads containing constructor keys",
      text: '{"city":"Seoul","constructor":{"bad":true}}',
      toolDefinitions: [tools[1]],
    },
    {
      name: "rejects nested prototype-sensitive keys",
      text: '{"name":"calc","arguments":{"a":1,"nested":{"prototype":{}}}}',
      toolDefinitions: tools,
    },
  ] satisfies readonly {
    readonly name: string;
    readonly text: string;
    readonly toolDefinitions: LanguageModelV4FunctionTool[];
  }[];

  for (const testCase of rejectCases) {
    it(testCase.name, () => {
      expect(
        recoverToolCallFromJsonCandidates(
          testCase.text,
          testCase.toolDefinitions
        )
      ).toBeNull();
    });
  }

  const lookupTool: LanguageModelV4FunctionTool = {
    type: "function",
    name: "lookup",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
    },
  };
  const statusCases = [
    {
      name: "preserves surrounding text when dropping sensitive known-tool candidates",
      text: 'Before {"name":"get_weather","arguments":{"constructor":{}}} after',
      expectedContent: [
        { type: "text", text: "Before " },
        { type: "text", text: " after" },
      ],
      toolDefinitions: tools,
    },
    {
      name: "preserves surrounding text when dropping known-tool candidates with sensitive string leaves",
      text: 'Before {"name":"get_weather","arguments":{"city":"__proto__: x"}} after',
      expectedContent: [
        { type: "text", text: "Before " },
        { type: "text", text: " after" },
      ],
      toolDefinitions: tools,
    },
    {
      name: "preserves surrounding text when dropping incomplete sensitive known-tool candidates",
      text: 'Before <tool_call>{"name":"get_weather","arguments":{"city":"Seoul","constructor":{"polluted":true}',
      expectedContent: [{ type: "text", text: "Before " }],
      toolDefinitions: tools,
    },
    {
      name: "drops incomplete sensitive candidates with unicode-escaped tool envelopes",
      text: '<tool_call>{"n\\u0061me":"get_weather","arguments":{"city":"Seoul","constructor":{"polluted":true}',
      expectedContent: [],
      toolDefinitions: [...tools, lookupTool],
    },
    {
      name: "drops incomplete sensitive candidates with unicode-escaped tool names",
      text: '<tool_call>{"name":"get_\\u0077eather","arguments":{"city":"Seoul","constructor":{"polluted":true}',
      expectedContent: [],
      toolDefinitions: [...tools, lookupTool],
    },
    {
      name: "drops double-encoded string arguments with prototype-sensitive keys",
      text: '{"name":"get_weather","arguments":"{\\"__proto__\\":{\\"polluted\\":true},\\"city\\":\\"Seoul\\"}"}',
      expectedContent: [],
      toolDefinitions: tools,
    },
    {
      name: "drops sensitive YAML tool-call blocks",
      text: "<tool_call>\nname: get_weather\narguments:\n  constructor: true\n  city: Seoul\n</tool_call>",
      expectedContent: [],
      toolDefinitions: tools,
    },
    {
      name: "drops YAML tool-call blocks with prototype-sensitive string arguments",
      text: "<tool_call>\nname: get_weather\narguments:\n  city: <prototype>Seoul</prototype>\n</tool_call>",
      expectedContent: [],
      toolDefinitions: tools,
    },
  ] satisfies readonly {
    readonly expectedContent: LanguageModelV4Content[];
    readonly name: string;
    readonly text: string;
    readonly toolDefinitions: LanguageModelV4FunctionTool[];
  }[];

  for (const testCase of statusCases) {
    it(testCase.name, () => {
      const recovered = recoverToolCallFromJsonCandidatesWithStatus(
        testCase.text,
        testCase.toolDefinitions
      );
      expect(recovered).toEqual({
        kind: "dropped-sensitive-candidate",
        content: testCase.expectedContent,
      });
    });
  }
});

describe("recoverToolCallFromJsonCandidates envelope variants", () => {
  const callCases = [
    {
      name: "accepts tool/parameters key aliases",
      text: '{"tool": "get_weather", "parameters": {"city": "Seoul"}}',
    },
    {
      name: "unwraps string-typed arguments",
      text: '{"name": "get_weather", "arguments": "{\\"city\\": \\"Seoul\\"}"}',
    },
  ] as const;

  for (const testCase of callCases) {
    it(testCase.name, () => {
      expectCall(testCase.text, "get_weather", { city: "Seoul" });
    });
  }

  it("recovers array-wrapped call lists without leaking punctuation", () => {
    const text =
      '[{"name":"get_weather","arguments":{"city":"Seoul"}}, {"name":"get_weather","arguments":{"city":"Tokyo"}}]';

    expectCallCountWithoutText(text, 2);
  });

  it("rejects prototype-sensitive keys in string-typed arguments", () => {
    const text =
      '{"name": "get_weather", "arguments": "{\\"__proto__\\": {}}"}';

    expect(recoverToolCallFromJsonCandidates(text, tools)).toBeNull();
  });
});

describe("recoverToolCallFromJsonCandidates cross-format blocks", () => {
  const qwenCases = [
    {
      name: "recovers Qwen-style function blocks (Step 3.5 shape)",
      text: "<tool_call>\n<function=get_weather>\n<parameter=city>\nSeoul\n</parameter>\n<parameter=mood>\nsunny\n</parameter>\n</function>\n</tool_call>",
    },
    {
      name: "recovers Qwen-style call blocks with name attributes",
      text: '<tool_call>\n<call name="get_weather">\n<parameter=city>Seoul</parameter>\n</call>\n</tool_call>',
    },
    {
      name: "recovers Qwen-style tool blocks with child tool_name tags",
      text: "<tool_call>\n<tool>\n<tool_name>get_weather</tool_name>\n<parameter=city>Seoul</parameter>\n</tool>\n</tool_call>",
    },
  ] as const;

  for (const testCase of qwenCases) {
    it(testCase.name, () => {
      expectCall(testCase.text, "get_weather", { city: "Seoul" });
    });
  }

  it("preserves text adjacent to a self-closing Qwen block", () => {
    // Given a self-closing call surrounded by plain text.
    const text = "before <function=get_weather/> after";

    // When cross-format recovery extracts the call span.
    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    // Then the complete tag is consumed without changing adjacent text.
    const call = findToolCall(recovered);
    expect(JSON.parse(call.input)).toEqual({});
    expect(recoveredText(recovered)).toBe("before  after");
  });

  it("terminates Qwen-style blocks at malformed close tags without swallowing trailing text", () => {
    const text =
      "<function=get_weather><parameter=city>Seoul</parameter></function garbage> done";

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    const call = findToolCall(recovered);
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({ city: "Seoul" });

    const textOut = recoveredText(recovered);
    expect(textOut).toContain(" done");
    expect(textOut).not.toContain("</function garbage>");
  });

  it("does not treat malformed close-like text inside a parameter as the block close", () => {
    const text =
      "<function=get_weather><parameter=city>literal </function garbage> text</parameter></function> done";

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    const call = findToolCall(recovered);
    expect(JSON.parse(call.input)).toEqual({
      city: "literal </function garbage> text",
    });

    const textOut = recoveredText(recovered);
    expect(textOut).toContain(" done");
  });

  it("uses a malformed close inside an unclosed parameter when no later call close exists", () => {
    const text =
      "<function=get_weather><parameter=city>Seoul </function garbage> done </parameter> tail";

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    const call = findToolCall(recovered);
    expect(JSON.parse(call.input)).toEqual({ city: "Seoul" });

    const textOut = recoveredText(recovered);
    expect(textOut).toContain(" done </parameter> tail");
    expect(textOut).not.toContain("</function garbage>");
  });

  it("handles many close-like parameter fragments without quadratic scanning", () => {
    const fragments = Array.from(
      { length: 8000 },
      (_, index) => `literal ${index} </function garbage>`
    ).join(" ");
    const text = `<function=get_weather><parameter=city>${fragments}</parameter></function> done`;

    const startedAt = performance.now();
    const recovered = recoverToolCallFromJsonCandidates(text, tools);
    const elapsedMs = performance.now() - startedAt;

    const call = findToolCall(recovered);
    const input = JSON.parse(call.input);
    expect(input.city).toContain("literal 0 </function garbage>");
    expect(input.city).toContain("literal 7999 </function garbage>");

    const textOut = recoveredText(recovered);
    expect(textOut).toContain(" done");
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("recovers YAML-bodied tool_call blocks with envelope (Granite shape)", () => {
    expectCall(
      "<tool_call>\nname: get_weather\narguments:\n  city: Seoul\n  unit: celsius\n</weather>",
      "get_weather",
      { city: "Seoul" }
    );
  });

  it("recovers bare-args YAML blocks closed with the tool name", () => {
    const text =
      "<tool_call>\ncity: Seoul\nunit: celsius\n</get_weather>\n<tool_call>\ncity: Tokyo\nunit: celsius\n</get_weather>";

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    const calls = findToolCalls(recovered);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => JSON.parse(c.input).city)).toEqual([
      "Seoul",
      "Tokyo",
    ]);
  });

  it("does not misread prose inside a tool_call block as YAML args", () => {
    const text = "<tool_call>\njust some prose here\n</tool_call>";

    expect(recoverToolCallFromJsonCandidates(text, tools)).toBeNull();
  });
});

describe("recoverToolCallFromJsonCandidates namespaced close tags", () => {
  it("trims namespaced garbage close tags and matches the tool name", () => {
    expectCall(
      "<tool_call>\nname: get_weather\narguments:\n  city: Seoul\n</functions:get_weather>",
      "get_weather",
      { city: "Seoul" }
    );
  });

  it("matches the tool from the namespaced close tag in bare-args form", () => {
    const text = "<tool_call>\ncity: Seoul\n</functions:get_weather>";

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    const call = findToolCall(recovered);
    expect(call).toBeDefined();
    expect(call.toolName).toBe("get_weather");
  });
});

describe("function key alias", () => {
  it("recovers a bare JSON payload using function/parameters keys", () => {
    const aliasTools: LanguageModelV4FunctionTool[] = [
      {
        type: "function" as const,
        name: "create_shipment",
        description: "Create a shipment.",
        inputSchema: {
          type: "object",
          properties: { zip: { type: "string" } },
          required: ["zip"],
        },
      },
    ];
    const out = recoverToolCallFromJsonCandidates(
      '{\n  "function": "create_shipment",\n  "parameters": { "zip": "01234" }\n}',
      aliasTools
    );
    const call = out?.find((part) => part.type === "tool-call");
    if (call?.type !== "tool-call") {
      throw new Error("Expected recovered tool-call part");
    }
    expect(call.toolName).toBe("create_shipment");
    expect(JSON.parse(call.input)).toEqual({ zip: "01234" });
  });
});
