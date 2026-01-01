import { describe, expect, it } from "vitest";

import { isToolChoiceActive } from "../../core/utils/provider-options";

describe("tools utils", () => {
  it("isToolChoiceActive detects required and tool types", () => {
    expect(
      isToolChoiceActive({
        providerOptions: {
          toolCallMiddleware: { toolChoice: { type: "required" } },
        },
      })
    ).toBe(true);
    expect(
      isToolChoiceActive({
        providerOptions: {
          toolCallMiddleware: { toolChoice: { type: "tool" } },
        },
      })
    ).toBe(true);
    expect(
      isToolChoiceActive({
        providerOptions: {
          toolCallMiddleware: { toolChoice: { type: "none" } },
        },
      })
    ).toBe(false);
    expect(isToolChoiceActive({} as any)).toBe(false);
  });
});
