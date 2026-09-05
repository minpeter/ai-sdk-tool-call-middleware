import { describe, expect, it, vi } from "vitest";
import { glm5Protocol } from "../../../core/protocols/glm5-protocol";
import { glm5Tools, normalizeContentToolCalls, toolCallInput } from "./shared";

function assertMalformedGeneratedCall(
  text: string,
  assertNoSegments = false
): void {
  const onError = vi.fn();
  const protocol = glm5Protocol();
  const output = protocol.parseGeneratedText({
    text,
    tools: glm5Tools,
    options: { onError },
  });
  expect(normalizeContentToolCalls(output)).toEqual([]);
  if (assertNoSegments) {
    expect(
      protocol.extractToolCallSegments?.({ text, tools: glm5Tools })
    ).toEqual([]);
  }
  expect(onError).toHaveBeenCalledWith(
    "Could not parse GLM-5.2 tool call.",
    expect.objectContaining({ dropReason: "malformed-glm5-tool-call" })
  );
}

function assertLiteralStringCall(message: string): void {
  const output = glm5Protocol().parseGeneratedText({
    text: `<tool_call>echo<arg_key>message</arg_key><arg_value>${message}</arg_value></tool_call>`,
    tools: glm5Tools,
  });
  expect(toolCallInput(output)).toEqual({ message });
  expect(output.filter((part) => part.type === "text")).toEqual([]);
}

describe("parse-generated-text.test split 3", () => {
  it("rejects a duplicate argument instead of selecting either value", () => {
    assertMalformedGeneratedCall(
      [
        "<tool_call>echo",
        "<arg_key>message</arg_key><arg_value>first</arg_value>",
        "<arg_key>message</arg_key><arg_value>second</arg_value>",
        "</tool_call>",
      ].join("")
    );
  });

  it.each(["__proto__", "prototype", "constructor"])(
    "rejects the entire call containing prototype-sensitive key %s",
    (key) => {
      assertMalformedGeneratedCall(
        `<tool_call>open_action<arg_key>${key}</arg_key><arg_value>unsafe</arg_value></tool_call>`
      );
      expect(Object.prototype).not.toHaveProperty("polluted");
    }
  );

  it.each([
    "__proto__",
    '"__proto__"',
    "\\u005f\\u005fproto\\u005f\\u005f",
    "&#95;&#95;proto&#95;&#95;",
  ])(
    "rejects closed-schema prototype-sensitive key spelling %s instead of dropping it as unknown",
    (key) => {
      const text = `<tool_call>echo<arg_key>${key}</arg_key><arg_value>{}</arg_value></tool_call>`;
      assertMalformedGeneratedCall(text, true);
      expect(Object.prototype).not.toHaveProperty("polluted");
    }
  );

  it("rejects a call whose structured value contains a prototype-sensitive key", () => {
    assertMalformedGeneratedCall(
      [
        "<tool_call>typed_action",
        "<arg_key>config</arg_key>",
        '<arg_value>{"__proto__":{"polluted":true}}</arg_value>',
        "</tool_call>",
      ].join("")
    );
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("preserves prototype-like JSON documents when the schema declares a string", () => {
    const output = glm5Protocol().parseGeneratedText({
      text: [
        "<tool_call>echo",
        "<arg_key>message</arg_key>",
        '<arg_value>{"constructor":"a normal class name","prototype":"design prototype"}</arg_value>',
        "</tool_call>",
      ].join(""),
      tools: glm5Tools,
    });

    expect(toolCallInput(output)).toEqual({
      message:
        '{"constructor":"a normal class name","prototype":"design prototype"}',
    });
  });

  it("rejects duplicate keys inside structured JSON argument values", () => {
    const output = glm5Protocol().parseGeneratedText({
      text: [
        "<tool_call>typed_action",
        "<arg_key>config</arg_key>",
        '<arg_value>{"mode":"first","mode":"second"}</arg_value>',
        "</tool_call>",
      ].join(""),
      tools: glm5Tools,
    });

    expect(normalizeContentToolCalls(output)).toEqual([]);
  });

  it("rejects nested duplicate keys even when a property schema is unconstrained", () => {
    const output = glm5Protocol().parseGeneratedText({
      text: [
        "<tool_call>open_action",
        "<arg_key>data</arg_key>",
        '<arg_value>{"a":1,"a":2}</arg_value>',
        "</tool_call>",
      ].join(""),
      tools: glm5Tools,
    });

    expect(normalizeContentToolCalls(output)).toEqual([]);
  });

  it("rejects duplicate keys in the alternate JSON-call recovery form", () => {
    const output = glm5Protocol().parseGeneratedText({
      text: [
        "<tool_call>",
        '{"name":"open_action","arguments":{"x":"first","x":"second"}}',
        "</tool_call>",
      ].join(""),
      tools: glm5Tools,
    });

    expect(normalizeContentToolCalls(output)).toEqual([]);
  });

  it.each(["[1,2", '{"mode":"safe"'])(
    "rejects a truncated structured value instead of loose coercion: %s",
    (value) => {
      const key = value.startsWith("[") ? "tags" : "config";
      const output = glm5Protocol().parseGeneratedText({
        text: `<tool_call>typed_action<arg_key>${key}</arg_key><arg_value>${value}`,
        tools: glm5Tools,
      });

      expect(normalizeContentToolCalls(output)).toEqual([]);
    }
  );

  it.each([
    "before <arg_key> literal after",
    "before </arg_value> literal after",
    "before <arg_key>city</arg_key><arg_value>literal</arg_value> after",
  ])("preserves tag-like text inside a schema string: %s", (message) => {
    const output = glm5Protocol().parseGeneratedText({
      text: `<tool_call>echo<arg_key>message</arg_key><arg_value>${message}</arg_value></tool_call>`,
      tools: glm5Tools,
    });

    expect(toolCallInput(output)).toEqual({ message });
  });

  it("does not terminate a call at a raw </tool_call> inside a string value", () => {
    const message = "before </tool_call> literal after";
    assertLiteralStringCall(message);
  });

  it.each([
    "before <tool_call> literal after",
    "before < tool_call > literal after",
    "before <tool_call>x</tool_call> literal after",
  ])(
    "does not confuse a raw opening tool marker with a nested call: %s",
    (message) => {
      assertLiteralStringCall(message);
    }
  );

  it("fails closed when a nested opening marker has no structurally clean outer close", () => {
    for (const nested of ["<tool_call>ping</tool_call>", "<tool_call>ping"]) {
      const onError = vi.fn();
      const output = glm5Protocol().parseGeneratedText({
        text: [
          "<tool_call>echo",
          "<arg_key>message</arg_key><arg_value>unsafe ",
          nested,
        ].join(""),
        tools: glm5Tools,
        options: { onError },
      });

      expect(normalizeContentToolCalls(output), nested).toEqual([]);
      expect(onError).toHaveBeenCalledWith(
        "Could not parse GLM-5.2 tool call.",
        expect.objectContaining({ dropReason: "malformed-glm5-tool-call" })
      );
    }
  });

  it("bounds close-candidate scanning and fails closed when the limit is exceeded", () => {
    const onError = vi.fn();
    const message = "x</tool_call>".repeat(300);
    const output = glm5Protocol().parseGeneratedText({
      text: `<tool_call>echo<arg_key>message</arg_key><arg_value>${message}</arg_value></tool_call>`,
      tools: glm5Tools,
      options: { onError },
    });

    expect(normalizeContentToolCalls(output)).toEqual([]);
    expect(onError).toHaveBeenCalledWith(
      "Could not parse GLM-5.2 tool call.",
      expect.objectContaining({ dropReason: "malformed-glm5-tool-call" })
    );
  });

  it.each([
    "before </tool_call> literal after",
    "before <tool_call> literal after",
    "before <tool_call>x</tool_call> literal after",
  ])(
    "extracts the complete raw segment across a literal marker: %s",
    (message) => {
      const call = `<tool_call>echo<arg_key>message</arg_key><arg_value>${message}</arg_value></tool_call>`;
      const text = `prefix ${call} suffix`;

      expect(
        glm5Protocol().extractToolCallSegments?.({ text, tools: glm5Tools })
      ).toEqual([call]);
    }
  );

  it("does not extract a recovery-only segment containing a nested opening marker", () => {
    const text = [
      "<tool_call>echo",
      "<arg_key>message</arg_key><arg_value>unsafe </tool_call> ",
      "<tool_call>ping</tool_call>",
    ].join("");

    expect(
      glm5Protocol().extractToolCallSegments?.({ text, tools: glm5Tools })
    ).toEqual([]);
    expect(
      normalizeContentToolCalls(
        glm5Protocol().parseGeneratedText({ text, tools: glm5Tools })
      )
    ).toEqual([]);
  });

  it.each([
    ["unknown tool", "<tool_call>unknown</tool_call>"],
    [
      "duplicate argument",
      [
        "<tool_call>echo",
        "<arg_key>message</arg_key><arg_value>first</arg_value>",
        "<arg_key>message</arg_key><arg_value>second</arg_value>",
        "</tool_call>",
      ].join(""),
    ],
  ])("resynchronizes after a rejected %s call", (_name, rejected) => {
    const valid = "<tool_call>ping</tool_call>";
    const protocol = glm5Protocol();

    expect(
      normalizeContentToolCalls(
        protocol.parseGeneratedText({
          text: rejected + valid,
          tools: glm5Tools,
        })
      )
    ).toEqual([{ toolName: "ping", input: {} }]);
    expect(
      protocol.extractToolCallSegments?.({
        text: rejected + valid,
        tools: glm5Tools,
      })
    ).toEqual([valid]);
  });
});
