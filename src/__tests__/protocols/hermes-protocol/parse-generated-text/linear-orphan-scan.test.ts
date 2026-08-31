import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";

const malformedUnit = "<tool_call>{\n";
const closedMalformedUnit = "<tool_call>{}</tool_call>";
const originalIndexOf = String.prototype.indexOf;
const originalSlice = String.prototype.slice;

function parseRepeatedMalformedCalls(repetitions: number) {
  const text = malformedUnit.repeat(repetitions);
  let delimiterChecks = 0;
  const indexOf = vi
    .spyOn(String.prototype, "indexOf")
    .mockImplementation(function (this: string, searchString, position) {
      if (String(this) === text && searchString === "</tool_call>") {
        delimiterChecks += text.length - (position ?? 0);
      }
      return originalIndexOf.call(String(this), searchString, position);
    });
  try {
    const content = hermesProtocol().parseGeneratedText({ text, tools: [] });
    return { content, text, work: delimiterChecks };
  } finally {
    indexOf.mockRestore();
  }
}

function parseClosedCallsBeforeMalformedTail(repetitions: number) {
  const text = closedMalformedUnit.repeat(repetitions) + malformedUnit;
  let suffixWork = 0;
  const slice = vi
    .spyOn(String.prototype, "slice")
    .mockImplementation(function (this: string, start, end) {
      const source = String(this);
      const result = originalSlice.call(source, start, end);
      if (source === text && end === undefined && start !== undefined) {
        suffixWork += result.length;
      }
      return result;
    });
  try {
    hermesProtocol().parseGeneratedText({ text, tools: [] });
    return { text, work: suffixWork };
  } finally {
    slice.mockRestore();
  }
}

describe("Hermes orphan scan complexity", () => {
  it("preserves repeated unterminated calls as text", () => {
    const { content, text } = parseRepeatedMalformedCalls(32);

    expect(
      content.map((part) => (part.type === "text" ? part.text : "")).join("")
    ).toBe(text);
    expect(content).not.toContainEqual(
      expect.objectContaining({ type: "tool-call" })
    );
  });

  it("bounds whole-suffix work when closed spans double", () => {
    const small = parseClosedCallsBeforeMalformedTail(128);
    const large = parseClosedCallsBeforeMalformedTail(256);

    expect(small.work).toBeGreaterThan(0);
    expect(large.work).toBeGreaterThan(0);
    expect(small.work).toBeLessThanOrEqual(small.text.length * 8);
    expect(large.work).toBeLessThanOrEqual(large.text.length * 8);
    expect(large.work).toBeLessThanOrEqual(small.work * 3);
  });
});
