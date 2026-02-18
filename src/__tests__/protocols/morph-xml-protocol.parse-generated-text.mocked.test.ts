import { describe, expect, it, vi } from "vitest";

import { morphXmlProtocol } from "../../core/protocols/morph-xml-protocol";

describe("morphXmlProtocol parseGeneratedText recovery via malformed XML", () => {
  it("recovers malformed XML by parsing available content", () => {
    const p = morphXmlProtocol();
    const onError = vi.fn();
    const tools = [
      {
        type: "function",
        name: "a",
        description: "",
        inputSchema: { type: "object" },
      },
    ] as any;
    // Use valid outer structure but malformed inner XML that will cause parsing to fail
    const text = "prefix <a><arg>1</arg><unclosed>tag</a> suffix";
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const toolCalls = out.filter((c) => c.type === "tool-call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ type: "tool-call", toolName: "a" });
    const input = JSON.parse((toolCalls[0] as { input: string }).input);
    expect(input).toHaveProperty("arg", 1);
    expect(input).toHaveProperty("unclosed", "tag");
    expect(onError).not.toHaveBeenCalled();
  });
});
