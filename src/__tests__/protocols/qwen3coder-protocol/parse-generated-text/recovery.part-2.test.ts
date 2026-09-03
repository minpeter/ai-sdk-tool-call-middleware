import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { emptyFunctionTools } from "../../../fixtures/function-tools";

describe("recovery.test split 2", () => {
  const tools = emptyFunctionTools;
  const bookFlightTool = {
    type: "function" as const,
    name: "book_flight",
    inputSchema: {
      type: "object",
      properties: {
        cabin: { type: "string" },
      },
    },
  } satisfies LanguageModelV4FunctionTool;

  it("redacts raw fallback for prototype-sensitive parameter name attributes", () => {
    const onError = vi.fn();
    const p = qwen3CoderProtocol();
    const text =
      '<tool_call><function=book_flight><parameter name="constructor">{"polluted":true}</parameter></function></tool_call>';

    const out = p.parseGeneratedText({
      text,
      tools: [
        {
          type: "function" as const,
          name: "book_flight",
          inputSchema: {
            type: "object",
            properties: {
              cabin: { type: "string" },
            },
          },
        },
      ],
      options: { emitRawToolCallTextOnError: true, onError },
    });

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(
      out
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    ).toBe("");
    expect(onError).toHaveBeenCalled();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain("constructor");
    expect(metadataText).not.toContain("<tool_call>");
  });

  it("redacts raw fallback for entity-encoded prototype-sensitive parameter name attributes", () => {
    const onError = vi.fn();
    const p = qwen3CoderProtocol();
    const text =
      '<tool_call><function=book_flight><parameter name="&#99;onstructor">{"polluted":true}</parameter></function></tool_call>';

    const out = p.parseGeneratedText({
      text,
      tools: [
        {
          type: "function" as const,
          name: "book_flight",
          inputSchema: {
            type: "object",
            properties: {
              cabin: { type: "string" },
            },
          },
        },
      ],
      options: { emitRawToolCallTextOnError: true, onError },
    });

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(
      out
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    ).toBe("");
    expect(onError).toHaveBeenCalled();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain("&#99;onstructor");
    expect(metadataText).not.toContain("<tool_call>");
  });

  it("drops prototype-sensitive XML child tags embedded inside string arg values", () => {
    const onError = vi.fn();
    const p = qwen3CoderProtocol();
    const text =
      "<tool_call><function=book_flight><parameter=payload><prototype>x</prototype></parameter></function></tool_call>";

    const out = p.parseGeneratedText({
      text,
      tools: [
        {
          type: "function" as const,
          name: "book_flight",
          inputSchema: {
            type: "object",
            properties: {
              payload: { type: "string" },
            },
          },
        },
      ],
      options: { onError },
    });

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(
      out
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    ).toBe("");
    expect(onError).toHaveBeenCalled();
  });

  it("drops unquoted-name prototype-sensitive XML child params embedded inside string arg values", () => {
    const onError = vi.fn();
    const p = qwen3CoderProtocol();
    const text =
      '<tool_call><function=book_flight><parameter=payload><parameter name=constructor>{"polluted":true}</parameter></parameter></function></tool_call>';

    const out = p.parseGeneratedText({
      text,
      tools: [
        {
          type: "function" as const,
          name: "book_flight",
          inputSchema: {
            type: "object",
            properties: {
              payload: { type: "string" },
            },
          },
        },
      ],
      options: { onError },
    });

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(
      out
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    ).toBe("");
    expect(onError).toHaveBeenCalled();
  });

  it("preserves ordinary prose that mentions constructor as a label", () => {
    const onError = vi.fn();
    const p = qwen3CoderProtocol();
    const text = "constructor: ordinary prose";

    const out = p.parseGeneratedText({
      text,
      tools,
      options: { emitRawToolCallTextOnError: true, onError },
    });

    expect(
      out
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    ).toBe(text);
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    "constructor: ordinary prose",
    "prototype: ordinary prose",
    "constructor: true",
  ] as const)("preserves schema-valid string parameter value %s", (cabin) => {
    const onError = vi.fn();
    const p = qwen3CoderProtocol();
    const text = `<tool_call><function=book_flight><parameter=cabin>${cabin}</parameter></function></tool_call>`;

    const out = p.parseGeneratedText({
      text,
      tools: [bookFlightTool],
      options: { onError },
    });
    const tool = out.find((part) => part.type === "tool-call");

    expect(tool?.type).toBe("tool-call");
    if (tool?.type !== "tool-call") {
      throw new Error("expected tool call");
    }
    expect(tool.toolName).toBe("book_flight");
    expect(JSON.parse(tool.input)).toEqual({ cabin });
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps original trailing text when incomplete <tool_call recovery fails", () => {
    const p = qwen3CoderProtocol();
    const text = "How to type <tool_call in docs?";

    const out = p.parseGeneratedText({ text, tools });
    const rejoined = out
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(rejoined).toBe(text);
  });

  it("keeps original remainder text after parsed blocks when trailing <tool_call is invalid", () => {
    const p = qwen3CoderProtocol();
    const validCall =
      "<tool_call><function=alpha><parameter=x>1</parameter></function></tool_call>";
    const trailing = " trailing <tool_call in docs?";

    const out = p.parseGeneratedText({
      text: `${validCall}${trailing}`,
      tools,
    });

    const [toolCall] = out;
    if (toolCall?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(toolCall.toolName).toBe("alpha");
    expect(JSON.parse(toolCall.input)).toEqual({ x: "1" });
    const rejoined = out
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(rejoined).toBe(trailing);
  });

  it("parses a single <tool_call> when </function> is missing", () => {
    const p = qwen3CoderProtocol();
    const text =
      "<tool_call><function=get_weather><parameter=city>Tokyo</parameter></tool_call>";

    const out = p.parseGeneratedText({ text, tools });
    const calls = out.filter((x) => x.type === "tool-call");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({ city: "Tokyo" });
  });

  it("parses multiple <tool_call> blocks when </function> is missing", () => {
    const p = qwen3CoderProtocol();
    const text = [
      "a ",
      "<tool_call><function=alpha><parameter=x>1</parameter></tool_call>",
      " b ",
      "<tool_call><function=beta><parameter=y>2</parameter></tool_call>",
      " c",
    ].join("");

    const out = p.parseGeneratedText({ text, tools });
    const calls = out.filter((x) => x.type === "tool-call");
    expect(calls).toHaveLength(2);
    const [alpha, beta] = calls;
    if (alpha?.type !== "tool-call" || beta?.type !== "tool-call") {
      throw new Error("Expected tool-call parts");
    }
    expect(alpha.toolName).toBe("alpha");
    expect(JSON.parse(alpha.input)).toEqual({ x: "1" });
    expect(beta.toolName).toBe("beta");
    expect(JSON.parse(beta.input)).toEqual({ y: "2" });
  });

  it("parses mixed <tool_call> blocks with and without </function>", () => {
    const p = qwen3CoderProtocol();
    const text = [
      "<tool_call><function=alpha><parameter=x>1</parameter></function></tool_call>",
      " and ",
      "<tool_call><function=beta><parameter=y>2</parameter></tool_call>",
    ].join("");

    const out = p.parseGeneratedText({ text, tools });
    const calls = out.filter((x) => x.type === "tool-call");
    expect(calls).toHaveLength(2);
    const [alpha, beta] = calls;
    if (alpha?.type !== "tool-call" || beta?.type !== "tool-call") {
      throw new Error("Expected tool-call parts");
    }
    expect(alpha.toolName).toBe("alpha");
    expect(JSON.parse(alpha.input)).toEqual({ x: "1" });
    expect(beta.toolName).toBe("beta");
    expect(JSON.parse(beta.input)).toEqual({ y: "2" });
  });

  it("parses trailing recoverable malformed call inside one <tool_call> block", () => {
    const p = qwen3CoderProtocol();
    const text =
      "<tool_call><function=alpha><parameter=x>1</parameter></function><function=beta><parameter=y>2</parameter></tool_call>";

    const out = p.parseGeneratedText({ text, tools });
    const calls = out.filter((part) => part.type === "tool-call");
    expect(calls).toHaveLength(2);
    const [alpha, beta] = calls;
    if (alpha?.type !== "tool-call" || beta?.type !== "tool-call") {
      throw new Error("Expected tool-call parts");
    }
    expect(alpha.toolName).toBe("alpha");
    expect(JSON.parse(alpha.input)).toEqual({ x: "1" });
    expect(beta.toolName).toBe("beta");
    expect(JSON.parse(beta.input)).toEqual({ y: "2" });
  });
});
