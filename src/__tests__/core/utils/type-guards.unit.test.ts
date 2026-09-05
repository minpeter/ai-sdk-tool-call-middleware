import { describe, expect, it } from "vitest";

import { isToolResultPart } from "../../../core/utils/type-guards";

describe("type-guards", () => {
  it("isToolResultPart returns true for valid tool-result", () => {
    const part = {
      type: "tool-result",
      toolName: "get_weather",
      toolCallId: "id-1",
      output: { ok: true },
    };
    expect(isToolResultPart(part)).toBe(true);
  });

  it("isToolResultPart returns false for invalid shapes", () => {
    expect(isToolResultPart({})).toBe(false);
    expect(
      isToolResultPart({ type: "tool-result", toolName: "x", output: 1 })
    ).toBe(false);
  });

  it("isToolResultPart keeps the property-access order observable via Proxy", () => {
    const events: string[] = [];
    const backing = {
      type: "tool-result",
      toolName: "calc",
      toolCallId: "call-1",
      output: { ok: true },
    };
    const proxy = new Proxy(backing, {
      get(target, property) {
        events.push(`get:${String(property)}`);
        return target[property as keyof typeof target];
      },
      has(_target, property) {
        events.push(`has:${String(property)}`);
        return property === "output";
      },
    });

    expect(isToolResultPart(proxy)).toBe(true);
    expect(events).toEqual([
      "get:type",
      "get:toolName",
      "get:toolCallId",
      "has:output",
    ]);
  });
});
