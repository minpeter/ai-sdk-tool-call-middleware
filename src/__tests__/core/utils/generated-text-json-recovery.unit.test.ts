import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { recoverToolCallFromJsonCandidates } from "../../../core/utils/generated-text-json-recovery";

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
  it("recovers every resolvable JSON candidate in order", () => {
    const text =
      'before {"name":"calc","arguments":{"a":1}} middle\n' +
      "```json\n" +
      '{"name":"calc","arguments":{"a":2}}\n' +
      "``` after";

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    expect(recovered).not.toBeNull();
    const calls = recovered?.filter(
      (part) => part.type === "tool-call"
    ) as any[];

    expect(calls).toHaveLength(2);
    expect(calls[0].toolName).toBe("calc");
    expect(JSON.parse(calls[0].input)).toEqual({ a: 1 });
    expect(JSON.parse(calls[1].input)).toEqual({ a: 2 });

    const textOut = recovered
      ?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
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

    const calls = recovered?.filter(
      (part) => part.type === "tool-call"
    ) as any[];
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

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    const calls = recovered?.filter(
      (part) => part.type === "tool-call"
    ) as any[];
    expect(calls).toHaveLength(2);
    expect(recovered?.some((part) => part.type === "text")).toBe(false);
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
    const tool = recovered?.find((part) => part.type === "tool-call") as any;

    expect(tool.toolName).toBe("calc");
    expect(JSON.parse(tool.input)).toEqual({ a: 3 });

    const textOut = recovered
      ?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(textOut).toContain("} prefix ");
    expect(textOut).toContain(" suffix");
  });

  it("recovers arguments-only payloads when a single tool is available", () => {
    const text = '{"city":"Seoul"}';

    const recovered = recoverToolCallFromJsonCandidates(text, [tools[1]]);

    expect(recovered).not.toBeNull();
    const tool = recovered?.find((part) => part.type === "tool-call") as any;
    expect(tool.toolName).toBe("get_weather");
    expect(JSON.parse(tool.input)).toEqual({ city: "Seoul" });
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

    expect(recovered).not.toBeNull();
    const tool = recovered?.find((part) => part.type === "tool-call") as any;
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
    const tool = recovered?.find((part) => part.type === "tool-call") as any;
    expect(tool.toolName).toBe("get_weather");

    const textOut = recovered
      ?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(textOut).not.toContain("<tool_call>");
  });

  it("strips a dangling close tag after the recovered payload", () => {
    const text = '{"name":"calc","arguments":{"a":1}}</tool_call>';

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    expect(recovered).not.toBeNull();
    const textOut = recovered
      ?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(textOut ?? "").not.toContain("</tool_call>");
  });

  it("keeps surrounding prose intact while trimming orphan tags", () => {
    const text = 'Sure thing:\n<tool_call>{"name":"calc","arguments":{"a":2}}';

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    expect(recovered).not.toBeNull();
    const textOut = recovered
      ?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(textOut).toContain("Sure thing:");
    expect(textOut).not.toContain("<tool_call>");
  });
});

describe("recoverToolCallFromJsonCandidates prototype-sensitive keys", () => {
  it("rejects payloads whose arguments contain __proto__", () => {
    const text = '{"name":"calc","arguments":{"__proto__":{"x":1}}}';

    expect(recoverToolCallFromJsonCandidates(text, tools)).toBeNull();
  });

  it("rejects unicode-escaped __proto__ envelopes that inherit tool names", () => {
    const text =
      '{"\\u005f\\u005fproto\\u005f\\u005f":{"name":"calc"},"arguments":{"a":1}}';

    expect(recoverToolCallFromJsonCandidates(text, tools)).toBeNull();
  });

  it("rejects arguments-only payloads containing constructor keys", () => {
    const text = '{"city":"Seoul","constructor":{"bad":true}}';

    expect(recoverToolCallFromJsonCandidates(text, [tools[1]])).toBeNull();
  });

  it("rejects nested prototype-sensitive keys", () => {
    const text =
      '{"name":"calc","arguments":{"a":1,"nested":{"prototype":{}}}}';

    expect(recoverToolCallFromJsonCandidates(text, tools)).toBeNull();
  });
});

describe("recoverToolCallFromJsonCandidates envelope variants", () => {
  it("accepts tool/parameters key aliases", () => {
    const text = '{"tool": "get_weather", "parameters": {"city": "Seoul"}}';

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    const call = recovered?.find((part) => part.type === "tool-call") as any;
    expect(call).toBeDefined();
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({ city: "Seoul" });
  });

  it("unwraps string-typed arguments", () => {
    const text =
      '{"name": "get_weather", "arguments": "{\\"city\\": \\"Seoul\\"}"}';

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    const call = recovered?.find((part) => part.type === "tool-call") as any;
    expect(call).toBeDefined();
    expect(JSON.parse(call.input)).toEqual({ city: "Seoul" });
  });

  it("recovers array-wrapped call lists without leaking punctuation", () => {
    const text =
      '[{"name":"get_weather","arguments":{"city":"Seoul"}}, {"name":"get_weather","arguments":{"city":"Tokyo"}}]';

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    const calls = recovered?.filter(
      (part) => part.type === "tool-call"
    ) as any[];
    expect(calls).toHaveLength(2);
    expect(recovered?.some((part) => part.type === "text")).toBe(false);
  });

  it("rejects prototype-sensitive keys in string-typed arguments", () => {
    const text =
      '{"name": "get_weather", "arguments": "{\\"__proto__\\": {}}"}';

    expect(recoverToolCallFromJsonCandidates(text, tools)).toBeNull();
  });
});

describe("recoverToolCallFromJsonCandidates cross-format blocks", () => {
  it("recovers Qwen-style function blocks (Step 3.5 shape)", () => {
    const text =
      "<tool_call>\n<function=get_weather>\n<parameter=city>\nSeoul\n</parameter>\n<parameter=mood>\nsunny\n</parameter>\n</function>\n</tool_call>";

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    const call = recovered?.find((part) => part.type === "tool-call") as any;
    expect(call).toBeDefined();
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({ city: "Seoul" });
  });

  it("recovers Qwen-style call blocks with name attributes", () => {
    const text =
      '<tool_call>\n<call name="get_weather">\n<parameter=city>Seoul</parameter>\n</call>\n</tool_call>';

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    const call = recovered?.find((part) => part.type === "tool-call") as any;
    expect(call).toBeDefined();
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({ city: "Seoul" });
  });

  it("recovers Qwen-style tool blocks with child tool_name tags", () => {
    const text =
      "<tool_call>\n<tool>\n<tool_name>get_weather</tool_name>\n<parameter=city>Seoul</parameter>\n</tool>\n</tool_call>";

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    const call = recovered?.find((part) => part.type === "tool-call") as any;
    expect(call).toBeDefined();
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({ city: "Seoul" });
  });

  it("terminates Qwen-style blocks at malformed close tags without swallowing trailing text", () => {
    const text =
      "<function=get_weather><parameter=city>Seoul</parameter></function garbage> done";

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    const call = recovered?.find((part) => part.type === "tool-call");
    if (call?.type !== "tool-call") {
      throw new Error("Expected a recovered tool call");
    }
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({ city: "Seoul" });

    const textOut = recovered
      ?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(textOut).toContain(" done");
    expect(textOut).not.toContain("</function garbage>");
  });

  it("does not treat malformed close-like text inside a parameter as the block close", () => {
    const text =
      "<function=get_weather><parameter=city>literal </function garbage> text</parameter></function> done";

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    const call = recovered?.find((part) => part.type === "tool-call");
    if (call?.type !== "tool-call") {
      throw new Error("Expected a recovered tool call");
    }
    expect(JSON.parse(call.input)).toEqual({
      city: "literal </function garbage> text",
    });

    const textOut = recovered
      ?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(textOut).toContain(" done");
  });

  it("uses a malformed close inside an unclosed parameter when no later call close exists", () => {
    const text =
      "<function=get_weather><parameter=city>Seoul </function garbage> done </parameter> tail";

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    const call = recovered?.find((part) => part.type === "tool-call");
    if (call?.type !== "tool-call") {
      throw new Error("Expected a recovered tool call");
    }
    expect(JSON.parse(call.input)).toEqual({ city: "Seoul" });

    const textOut = recovered
      ?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
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

    const call = recovered?.find((part) => part.type === "tool-call");
    if (call?.type !== "tool-call") {
      throw new Error("Expected a recovered tool call");
    }
    const input = JSON.parse(call.input);
    expect(input.city).toContain("literal 0 </function garbage>");
    expect(input.city).toContain("literal 7999 </function garbage>");

    const textOut = recovered
      ?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(textOut).toContain(" done");
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("recovers YAML-bodied tool_call blocks with envelope (Granite shape)", () => {
    const text =
      "<tool_call>\nname: get_weather\narguments:\n  city: Seoul\n  unit: celsius\n</weather>";

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    const call = recovered?.find((part) => part.type === "tool-call") as any;
    expect(call).toBeDefined();
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({ city: "Seoul" });
  });

  it("recovers bare-args YAML blocks closed with the tool name", () => {
    const text =
      "<tool_call>\ncity: Seoul\nunit: celsius\n</get_weather>\n<tool_call>\ncity: Tokyo\nunit: celsius\n</get_weather>";

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    const calls = recovered?.filter(
      (part) => part.type === "tool-call"
    ) as any[];
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
    const text =
      "<tool_call>\nname: get_weather\narguments:\n  city: Seoul\n</functions:get_weather>";

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    const call = recovered?.find((part) => part.type === "tool-call") as any;
    expect(call).toBeDefined();
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({ city: "Seoul" });
  });

  it("matches the tool from the namespaced close tag in bare-args form", () => {
    const text = "<tool_call>\ncity: Seoul\n</functions:get_weather>";

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    const call = recovered?.find((part) => part.type === "tool-call") as any;
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
