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
      "<tool_call>\n<function=get_weather>\n<parameter=city>\nSeoul\n</parameter>\n</function>\n</tool_call>";

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    const call = recovered?.find((part) => part.type === "tool-call") as any;
    expect(call).toBeDefined();
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({ city: "Seoul" });
  });

  it("recovers YAML-bodied tool_call blocks with envelope (Granite shape)", () => {
    const text =
      "<tool_call>\nname: get_weather\narguments:\n  city: Seoul\n  unit: celsius\n</weather>";

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    const call = recovered?.find((part) => part.type === "tool-call") as any;
    expect(call).toBeDefined();
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({ city: "Seoul", unit: "celsius" });
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
