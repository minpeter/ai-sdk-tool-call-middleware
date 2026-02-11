import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
  emitFinalRemainder,
  emitPrefixDelta,
  toIncompleteJsonPrefix,
} from "../../core/utils/streamed-tool-input-delta";

function createMockController(
  out: LanguageModelV3StreamPart[]
): TransformStreamDefaultController<LanguageModelV3StreamPart> {
  return {
    enqueue(part: LanguageModelV3StreamPart) {
      out.push(part);
    },
  } as unknown as TransformStreamDefaultController<LanguageModelV3StreamPart>;
}

describe("streamed-tool-input-delta", () => {
  it("toIncompleteJsonPrefix removes trailing closers and one closing quote", () => {
    expect(toIncompleteJsonPrefix('{"location":"Seo"}')).toBe(
      '{"location":"Seo'
    );
    expect(toIncompleteJsonPrefix('{"meta":{"ok":true}}')).toBe(
      '{"meta":{"ok":true'
    );
    expect(toIncompleteJsonPrefix('{"days":["mon","tue"]}')).toBe(
      '{"days":["mon","tue'
    );
    expect(toIncompleteJsonPrefix("{}")).toBe("{");
  });

  it("emitPrefixDelta emits only monotonic suffix deltas", () => {
    const out: LanguageModelV3StreamPart[] = [];
    const controller = createMockController(out);
    const state = { emittedInput: "" };

    emitPrefixDelta({
      controller,
      id: "tool-1",
      state,
      candidate: '{"location":"Seo',
    });
    emitPrefixDelta({
      controller,
      id: "tool-1",
      state,
      candidate: '{"location":"Seoul","unit":"ce',
    });
    const emittedBeforeMismatch = state.emittedInput;
    emitPrefixDelta({
      controller,
      id: "tool-1",
      state,
      candidate: '{"loc":"x',
    });

    const deltas = out.filter(
      (
        part
      ): part is Extract<
        LanguageModelV3StreamPart,
        { type: "tool-input-delta" }
      > => part.type === "tool-input-delta"
    );

    expect(deltas.map((part) => part.delta)).toEqual([
      '{"location":"Seo',
      'ul","unit":"ce',
    ]);
    expect(state.emittedInput).toBe(emittedBeforeMismatch);
  });

  it("emitFinalRemainder appends the missing suffix for the final JSON", () => {
    const out: LanguageModelV3StreamPart[] = [];
    const controller = createMockController(out);
    const state = { emittedInput: '{"location":"Seoul","unit":"ce' };

    emitFinalRemainder({
      controller,
      id: "tool-2",
      state,
      finalFullJson: '{"location":"Seoul","unit":"celsius"}',
    });

    const deltas = out.filter(
      (
        part
      ): part is Extract<
        LanguageModelV3StreamPart,
        { type: "tool-input-delta" }
      > => part.type === "tool-input-delta"
    );
    expect(deltas).toHaveLength(1);
    expect(deltas[0].delta).toBe('lsius"}');
    expect(state.emittedInput).toBe('{"location":"Seoul","unit":"celsius"}');
  });

  it("emitFinalRemainder does not emit when final JSON does not extend emitted prefix", () => {
    const out: LanguageModelV3StreamPart[] = [];
    const controller = createMockController(out);
    const state = { emittedInput: '{"location":"Seoul"' };

    const emitted = emitFinalRemainder({
      controller,
      id: "tool-3",
      state,
      finalFullJson: '{"city":"Seoul"}',
    });

    expect(emitted).toBe(false);
    expect(out).toHaveLength(0);
    expect(state.emittedInput).toBe('{"location":"Seoul"');
  });
});
