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
});
