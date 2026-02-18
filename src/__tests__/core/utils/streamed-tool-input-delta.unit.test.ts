import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import {
  emitFinalRemainder,
  emitPrefixDelta,
  toIncompleteJsonPrefix,
} from "../../../core/utils/streamed-tool-input-delta";

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

  it("toIncompleteJsonPrefix returns appropriate starter when trimming collapses to empty", () => {
    expect(toIncompleteJsonPrefix('"}')).toBe('"');
    expect(toIncompleteJsonPrefix("]}")).toBe("[");
    expect(toIncompleteJsonPrefix("}}")).toBe("{");
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
    const onMismatch = vi.fn();

    const emitted = emitFinalRemainder({
      controller,
      id: "tool-3",
      state,
      finalFullJson: '{"city":"Seoul"}',
      onMismatch,
    });

    expect(emitted).toBe(false);
    expect(out).toHaveLength(0);
    expect(state.emittedInput).toBe('{"location":"Seoul"');
    expect(onMismatch).toHaveBeenCalledTimes(1);
    expect(onMismatch).toHaveBeenCalledWith(
      "Final JSON does not extend emitted tool-input prefix",
      {
        emittedLength: state.emittedInput.length,
        finalLength: '{"city":"Seoul"}'.length,
      }
    );
  });
});

describe("toIncompleteJsonPrefix comprehensive edge cases", () => {
  it("returns '[' for empty array '[]'", () => {
    expect(toIncompleteJsonPrefix("[]")).toBe("[");
  });

  it("returns '[' for array with only closers", () => {
    expect(toIncompleteJsonPrefix("]}")).toBe("[");
  });

  it("returns '{' for object with only closers", () => {
    expect(toIncompleteJsonPrefix("}}")).toBe("{");
  });

  it("returns '{' for object starting with '{'", () => {
    expect(toIncompleteJsonPrefix("{}")).toBe("{");
  });

  it("handles nested arrays correctly", () => {
    expect(toIncompleteJsonPrefix("[[1,2],[3]]")).toBe("[[1,2],[3");
  });

  it("handles nested objects correctly", () => {
    expect(toIncompleteJsonPrefix('{"a":{"b":1}}')).toBe('{"a":{"b":1');
  });

  it("handles mixed nested structures", () => {
    expect(toIncompleteJsonPrefix('{"items":[{"x":1}]}')).toBe(
      '{"items":[{"x":1'
    );
  });

  it("returns '\"' for string root starting with quote", () => {
    expect(toIncompleteJsonPrefix('""')).toBe('"');
  });

  it("returns '\"' for string with only closing quote", () => {
    expect(toIncompleteJsonPrefix('"}')).toBe('"');
  });

  it("handles whitespace in trimmed input for object", () => {
    expect(toIncompleteJsonPrefix("  {  }  ")).toBe("{");
  });

  it("handles whitespace in trimmed input for array", () => {
    expect(toIncompleteJsonPrefix("  [  ]  ")).toBe("[");
  });

  it("returns '{' as default for unrecognized input that collapses to empty", () => {
    expect(toIncompleteJsonPrefix("}")).toBe("{");
    expect(toIncompleteJsonPrefix("]")).toBe("[");
  });

  it("returns non-JSON input unchanged", () => {
    expect(toIncompleteJsonPrefix("xyz")).toBe("xyz");
  });

  it("handles deeply nested structures", () => {
    expect(toIncompleteJsonPrefix('{"a":{"b":{"c":{"d":1}}}}')).toBe(
      '{"a":{"b":{"c":{"d":1'
    );
  });

  it("handles array of objects", () => {
    expect(toIncompleteJsonPrefix('[{"a":1},{"b":2}]')).toBe('[{"a":1},{"b":2');
  });

  it("handles string values correctly", () => {
    expect(toIncompleteJsonPrefix('{"name":"test"}')).toBe('{"name":"test');
  });

  it("handles incomplete string values", () => {
    expect(toIncompleteJsonPrefix('{"msg":"hel')).toBe('{"msg":"hel');
  });

  it("returns '[' when trimmed starts with ']'", () => {
    expect(toIncompleteJsonPrefix("]")).toBe("[");
    expect(toIncompleteJsonPrefix("  ]  ")).toBe("[");
  });

  it("returns '{' when trimmed starts with '}'", () => {
    expect(toIncompleteJsonPrefix("}")).toBe("{");
    expect(toIncompleteJsonPrefix("  }  ")).toBe("{");
  });

  it("handles numbers in arrays", () => {
    expect(toIncompleteJsonPrefix("[1,2,3]")).toBe("[1,2,3");
  });

  it("handles boolean values", () => {
    expect(toIncompleteJsonPrefix('{"active":true}')).toBe('{"active":true');
  });

  it("handles null values", () => {
    expect(toIncompleteJsonPrefix('{"value":null}')).toBe('{"value":null');
  });

  it("handles empty string input", () => {
    expect(toIncompleteJsonPrefix("")).toBe("{");
  });

  it("handles whitespace-only input", () => {
    expect(toIncompleteJsonPrefix("   ")).toBe("{");
  });
});

describe("emitFinalRemainder onMismatch callback", () => {
  it("calls onMismatch when final does not extend prefix", () => {
    const out: LanguageModelV3StreamPart[] = [];
    const controller = createMockController(out);
    const state = { emittedInput: '{"location":"Seoul"' };
    const onMismatch = vi.fn();

    emitFinalRemainder({
      controller,
      id: "tool-mismatch",
      state,
      finalFullJson: '{"city":"Busan"}',
      onMismatch,
    });

    expect(onMismatch).toHaveBeenCalledTimes(1);
    expect(onMismatch).toHaveBeenCalledWith(
      "Final JSON does not extend emitted tool-input prefix",
      {
        emittedLength: '{"location":"Seoul"'.length,
        finalLength: '{"city":"Busan"}'.length,
      }
    );
  });

  it("does not call onMismatch when prefix is empty", () => {
    const out: LanguageModelV3StreamPart[] = [];
    const controller = createMockController(out);
    const state = { emittedInput: "" };
    const onMismatch = vi.fn();

    emitFinalRemainder({
      controller,
      id: "tool-empty",
      state,
      finalFullJson: '{"city":"Seoul"}',
      onMismatch,
    });

    expect(onMismatch).not.toHaveBeenCalled();
  });

  it("does not call onMismatch when final extends prefix", () => {
    const out: LanguageModelV3StreamPart[] = [];
    const controller = createMockController(out);
    const state = { emittedInput: '{"location":"Seoul"' };
    const onMismatch = vi.fn();

    emitFinalRemainder({
      controller,
      id: "tool-success",
      state,
      finalFullJson: '{"location":"Seoul"}',
      onMismatch,
    });

    expect(onMismatch).not.toHaveBeenCalled();
  });

  it("does not throw when onMismatch is undefined", () => {
    const out: LanguageModelV3StreamPart[] = [];
    const controller = createMockController(out);
    const state = { emittedInput: '{"location":"Seoul"' };

    expect(() =>
      emitFinalRemainder({
        controller,
        id: "tool-no-callback",
        state,
        finalFullJson: '{"city":"Busan"}',
      })
    ).not.toThrow();
  });
});
