import { describe, expect, it } from "vitest";

import { hermesProtocol } from "../../../core/protocols/hermes-protocol";

describe("hermesProtocol options", () => {
  it.each([
    "toolCallStart",
    "toolCallEnd",
  ] as const)("rejects an empty %s delimiter", (optionName) => {
    expect(() => hermesProtocol({ [optionName]: "" })).toThrow(
      `hermesProtocol ${optionName} must not be empty`
    );
  });

  it("still accepts non-empty custom delimiters", () => {
    const protocol = hermesProtocol({
      toolCallStart: "[[tool]]",
      toolCallEnd: "[[/tool]]",
    });

    const out = protocol.parseGeneratedText({
      text: 'before [[tool]]{"name":"ok","arguments":{}}[[/tool]] after',
      tools: [],
    });

    const toolCall = out.find((part) => part.type === "tool-call") as any;
    expect(toolCall).toBeTruthy();
    expect(toolCall.toolName).toBe("ok");
    expect(JSON.parse(toolCall.input)).toEqual({});
  });

  it("does not treat an unquoted RJSON key matching a custom start delimiter as nested", () => {
    const protocol = hermesProtocol({
      toolCallStart: "name",
      toolCallEnd: "END",
    });

    const text = 'name{name:"ok",arguments:{}}END';
    const out = protocol.parseGeneratedText({ text, tools: [] });
    const toolCall = out.find((part) => part.type === "tool-call") as any;

    expect(toolCall).toBeTruthy();
    expect(toolCall.toolName).toBe("ok");
    expect(JSON.parse(toolCall.input)).toEqual({});
    expect(protocol.extractToolCallSegments?.({ text, tools: [] })).toEqual([
      text,
    ]);
  });

  it("does not treat a nested RJSON property matching a custom start delimiter as nested", () => {
    const protocol = hermesProtocol({
      toolCallStart: "name:",
      toolCallEnd: "END",
    });

    const text = 'name:{name:"ok",arguments:{name:{a:1}}}END';
    const out = protocol.parseGeneratedText({ text, tools: [] });
    const toolCall = out.find((part) => part.type === "tool-call") as any;

    expect(toolCall).toBeTruthy();
    expect(toolCall.toolName).toBe("ok");
    expect(JSON.parse(toolCall.input)).toEqual({ name: { a: 1 } });
    expect(protocol.extractToolCallSegments?.({ text, tools: [] })).toEqual([
      text,
    ]);
  });

  it("does not treat comma-delimited RJSON properties matching a custom delimiter as nested", () => {
    const protocol = hermesProtocol({
      toolCallStart: "name:",
      toolCallEnd: "END",
    });

    const text = 'name:{name:"ok",arguments:{x:1,name:{a:1}}}END';
    const out = protocol.parseGeneratedText({ text, tools: [] });
    const toolCall = out.find((part) => part.type === "tool-call") as any;

    expect(toolCall).toBeTruthy();
    expect(toolCall.toolName).toBe("ok");
    expect(JSON.parse(toolCall.input)).toEqual({ x: 1, name: { a: 1 } });
  });

  it("does not treat spaced RJSON properties matching a custom delimiter as nested", () => {
    const protocol = hermesProtocol({
      toolCallStart: "name:",
      toolCallEnd: "END",
    });

    const text = 'name:{name:"ok",arguments:{x:1, name:{a:1}}}END';
    const out = protocol.parseGeneratedText({ text, tools: [] });
    const toolCall = out.find((part) => part.type === "tool-call") as any;

    expect(toolCall).toBeTruthy();
    expect(toolCall.toolName).toBe("ok");
    expect(JSON.parse(toolCall.input)).toEqual({ x: 1, name: { a: 1 } });
  });
});
