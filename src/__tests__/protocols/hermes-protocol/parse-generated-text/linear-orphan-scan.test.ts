import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";

const malformedUnit = "<tool_call>{\n";
const originalIndexOf = String.prototype.indexOf;

function parseRepeatedMalformedCalls(repetitions: number) {
  const text = malformedUnit.repeat(repetitions);
  let delimiterChecks = 0;
  const indexOf = vi
    .spyOn(String.prototype, "indexOf")
    .mockImplementation(function (this: string, searchString, position) {
      if (String(this) === text && searchString === "</tool_call>") {
        delimiterChecks += 1;
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

  it("bounds scan work when malformed input doubles", () => {
    const small = parseRepeatedMalformedCalls(256);
    const large = parseRepeatedMalformedCalls(512);

    expect(small.work).toBeGreaterThan(0);
    expect(large.work).toBeGreaterThan(0);
    expect(small.work).toBeLessThanOrEqual(small.text.length * 8);
    expect(large.work).toBeLessThanOrEqual(large.text.length * 8);
    expect(large.work).toBeLessThanOrEqual(small.work * 3);
  });
});
