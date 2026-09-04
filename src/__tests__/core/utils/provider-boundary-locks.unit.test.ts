import { describe, expect, it, vi } from "vitest";

import { normalizeForcedToolChoiceFinishReason } from "../../../core/utils/finish-reason";
import { extractOnErrorOption } from "../../../core/utils/on-error";
import {
  getToolCallMiddlewareOptions,
  isToolChoiceActive,
  isToolChoiceNone,
  mergeToolCallMiddlewareOptions,
} from "../../../core/utils/provider-options";
import { isToolResultPart } from "../../../core/utils/type-guards";

describe("provider boundary behavior locks", () => {
  it.each([
    ["tool", true, false],
    ["required", true, false],
    ["none", false, true],
    ["auto", false, false],
    ["provider-custom", false, false],
  ])(
    "classifies the %s tool-choice mode",
    (type, expectedActive, expectedNone) => {
      // Given
      const params = {
        providerOptions: { toolCallMiddleware: { toolChoice: { type } } },
      };

      // When
      const active = isToolChoiceActive(params);
      const none = isToolChoiceNone(params);

      // Then
      expect({ active, none }).toEqual({
        active: expectedActive,
        none: expectedNone,
      });
    }
  );

  it("merges middleware overrides while cloning and forwarding symbol values", () => {
    // Given
    const providerSymbol = Symbol("provider");
    const middlewareSymbol = Symbol("middleware");
    const providerOptions = {
      customProvider: { marker: providerSymbol },
      toolCallMiddleware: { preserved: middlewareSymbol, replaced: "old" },
    };

    // When
    const merged = mergeToolCallMiddlewareOptions(providerOptions, {
      replaced: "new",
    });

    // Then
    expect(merged).not.toBe(providerOptions);
    expect(merged.customProvider).toBe(providerOptions.customProvider);
    expect(merged.toolCallMiddleware).toEqual({
      preserved: middlewareSymbol,
      replaced: "new",
    });
    expect(getToolCallMiddlewareOptions(merged)).toBe(
      merged.toolCallMiddleware
    );
  });

  it("preserves a terminal finish reason and valid raw provider value", () => {
    // Given
    const finishReason = { unified: "length", raw: "max_tokens" };

    // When
    const normalized = normalizeForcedToolChoiceFinishReason(finishReason);

    // Then
    expect(normalized).toEqual(finishReason);
    expect(normalized.raw).toBe("max_tokens");
  });

  it("normalizes a malformed terminal raw finish reason to undefined", () => {
    // Given
    const finishReason = { unified: "error", raw: Symbol("malformed") };

    // When
    const normalized = normalizeForcedToolChoiceFinishReason(finishReason);

    // Then
    expect(normalized).toEqual({ unified: "error", raw: undefined });
  });

  it("passes through callable onError and rejects truthy strings", () => {
    // Given
    const onError = vi.fn();

    // When
    const functionOption = extractOnErrorOption({
      toolCallMiddleware: { onError },
    });
    const stringOption = extractOnErrorOption({
      toolCallMiddleware: { onError: "not callable" },
    });

    // Then
    expect(functionOption).toEqual({ onError });
    expect(stringOption).toBeUndefined();
  });

  it.each([
    undefined,
    {},
    { toolCallMiddleware: {} },
    { toolCallMiddleware: { onError: false } },
    { toolCallMiddleware: { onError: "" } },
    { toolCallMiddleware: { onError: 0 } },
    { toolCallMiddleware: { onError: null } },
  ])("omits absent or falsy onError values", (providerOptions) => {
    // Given / When
    const option = extractOnErrorOption(providerOptions);

    // Then
    expect(option).toBeUndefined();
  });

  it("accepts a shallow tool-result whose output is not SDK-union-valid", () => {
    // Given
    const content = {
      type: "tool-result",
      toolName: "lookup",
      toolCallId: "call-1",
      output: Symbol("shallow-output"),
    };

    // When
    const accepted = isToolResultPart(content);

    // Then
    expect(accepted).toBe(true);
  });
});
