import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PipelineConfig,
  ToolCallHeuristic,
} from "../../protocols/heuristic-engine";
import {
  applyHeuristicPipeline,
  createIntermediateCall,
  mergePipelineConfigs,
} from "../../protocols/heuristic-engine";

describe("heuristic-engine", () => {
  describe("createIntermediateCall", () => {
    it("creates an IntermediateCall with correct initial values", () => {
      const ctx = createIntermediateCall("myTool", "<raw>content</raw>", {
        type: "object",
      });

      expect(ctx.toolName).toBe("myTool");
      expect(ctx.rawSegment).toBe("<raw>content</raw>");
      expect(ctx.schema).toEqual({ type: "object" });
      expect(ctx.parsed).toBeNull();
      expect(ctx.errors).toEqual([]);
      expect(ctx.meta?.originalContent).toBe("<raw>content</raw>");
    });
  });

  describe("mergePipelineConfigs", () => {
    it("merges multiple pipeline configs", () => {
      const h1: ToolCallHeuristic = {
        id: "h1",
        phase: "pre-parse",
        applies: () => true,
        run: () => ({}),
      };
      const h2: ToolCallHeuristic = {
        id: "h2",
        phase: "fallback-reparse",
        applies: () => true,
        run: () => ({}),
      };
      const h3: ToolCallHeuristic = {
        id: "h3",
        phase: "post-parse",
        applies: () => true,
        run: () => ({}),
      };

      const config1: PipelineConfig = { preParse: [h1] };
      const config2: PipelineConfig = { fallbackReparse: [h2] };
      const config3: PipelineConfig = { postParse: [h3] };

      const merged = mergePipelineConfigs(config1, config2, config3);

      expect(merged.preParse).toHaveLength(1);
      expect(merged.fallbackReparse).toHaveLength(1);
      expect(merged.postParse).toHaveLength(1);
      expect(merged.preParse?.[0].id).toBe("h1");
      expect(merged.fallbackReparse?.[0].id).toBe("h2");
      expect(merged.postParse?.[0].id).toBe("h3");
    });

    it("concatenates heuristics from same phase", () => {
      const h1: ToolCallHeuristic = {
        id: "h1",
        phase: "pre-parse",
        applies: () => true,
        run: () => ({}),
      };
      const h2: ToolCallHeuristic = {
        id: "h2",
        phase: "pre-parse",
        applies: () => true,
        run: () => ({}),
      };

      const config1: PipelineConfig = { preParse: [h1] };
      const config2: PipelineConfig = { preParse: [h2] };

      const merged = mergePipelineConfigs(config1, config2);

      expect(merged.preParse).toHaveLength(2);
      expect(merged.preParse?.[0].id).toBe("h1");
      expect(merged.preParse?.[1].id).toBe("h2");
    });

    it("returns empty arrays when no configs provided", () => {
      const merged = mergePipelineConfigs();

      expect(merged.preParse).toEqual([]);
      expect(merged.fallbackReparse).toEqual([]);
      expect(merged.postParse).toEqual([]);
    });
  });

  describe("applyHeuristicPipeline", () => {
    const mockParse = vi.fn((xml: string, _schema: unknown) => {
      if (xml.includes("invalid")) {
        throw new Error("Parse error");
      }
      return { parsed: true, content: xml };
    });

    beforeEach(() => {
      mockParse.mockClear();
    });

    it("parses successfully without heuristics", () => {
      const ctx = createIntermediateCall("tool", "<valid>data</valid>", {});
      const config: PipelineConfig = {};

      const result = applyHeuristicPipeline(ctx, config, { parse: mockParse });

      expect(result.parsed).toEqual({
        parsed: true,
        content: "<valid>data</valid>",
      });
      expect(result.errors).toEqual([]);
    });

    it("applies pre-parse heuristics before parsing", () => {
      const preParseHeuristic: ToolCallHeuristic = {
        id: "normalize",
        phase: "pre-parse",
        applies: () => true,
        run: (ctx) => ({
          rawSegment: ctx.rawSegment.replace("BAD", "GOOD"),
        }),
      };

      const ctx = createIntermediateCall("tool", "<tag>BAD</tag>", {});
      const config: PipelineConfig = { preParse: [preParseHeuristic] };

      applyHeuristicPipeline(ctx, config, { parse: mockParse });

      expect(mockParse).toHaveBeenCalledWith("<tag>GOOD</tag>", {});
    });

    it("applies fallback-reparse when initial parse fails", () => {
      const fallbackHeuristic: ToolCallHeuristic = {
        id: "fix-xml",
        phase: "fallback-reparse",
        applies: () => true,
        run: (ctx) => ({
          rawSegment: ctx.rawSegment.replace("invalid", "valid"),
          reparse: true,
        }),
      };

      const ctx = createIntermediateCall("tool", "<tag>invalid</tag>", {});
      const config: PipelineConfig = { fallbackReparse: [fallbackHeuristic] };

      const result = applyHeuristicPipeline(ctx, config, { parse: mockParse });

      expect(result.parsed).toEqual({
        parsed: true,
        content: "<tag>valid</tag>",
      });
      expect(result.errors).toEqual([]);
    });

    it("applies post-parse heuristics after successful parse", () => {
      const postParseHeuristic: ToolCallHeuristic = {
        id: "transform",
        phase: "post-parse",
        applies: (ctx) => ctx.parsed !== null,
        run: (ctx) => ({
          parsed: { ...(ctx.parsed as object), transformed: true },
        }),
      };

      const ctx = createIntermediateCall("tool", "<valid>data</valid>", {});
      const config: PipelineConfig = { postParse: [postParseHeuristic] };

      const result = applyHeuristicPipeline(ctx, config, { parse: mockParse });

      expect(result.parsed).toEqual({
        parsed: true,
        content: "<valid>data</valid>",
        transformed: true,
      });
    });

    it("skips heuristics when applies returns false", () => {
      const runSpy = vi.fn(() => ({}));
      const skippedHeuristic: ToolCallHeuristic = {
        id: "skipped",
        phase: "pre-parse",
        applies: () => false,
        run: runSpy,
      };

      const ctx = createIntermediateCall("tool", "<valid>data</valid>", {});
      const config: PipelineConfig = { preParse: [skippedHeuristic] };

      applyHeuristicPipeline(ctx, config, { parse: mockParse });

      expect(runSpy).not.toHaveBeenCalled();
    });

    it("stops processing when stop is true", () => {
      const firstHeuristic: ToolCallHeuristic = {
        id: "stopper",
        phase: "pre-parse",
        applies: () => true,
        run: () => ({ stop: true }),
      };
      const secondSpy = vi.fn(() => ({}));
      const secondHeuristic: ToolCallHeuristic = {
        id: "after-stop",
        phase: "pre-parse",
        applies: () => true,
        run: secondSpy,
      };

      const ctx = createIntermediateCall("tool", "<valid>data</valid>", {});
      const config: PipelineConfig = {
        preParse: [firstHeuristic, secondHeuristic],
      };

      applyHeuristicPipeline(ctx, config, { parse: mockParse });

      expect(secondSpy).not.toHaveBeenCalled();
    });

    it("collects warnings from heuristics", () => {
      const warningHeuristic: ToolCallHeuristic = {
        id: "warner",
        phase: "pre-parse",
        applies: () => true,
        run: () => ({ warnings: ["Warning 1", "Warning 2"] }),
      };

      const ctx = createIntermediateCall("tool", "<valid>data</valid>", {});
      const config: PipelineConfig = { preParse: [warningHeuristic] };

      const result = applyHeuristicPipeline(ctx, config, { parse: mockParse });

      expect(result.meta?.warnings).toEqual(["Warning 1", "Warning 2"]);
    });

    it("respects maxReparses option", () => {
      let reparseCount = 0;
      const reparseTrigger: ToolCallHeuristic = {
        id: "reparse-trigger",
        phase: "fallback-reparse",
        applies: () => true,
        run: () => {
          reparseCount++;
          return { rawSegment: "<still>invalid</still>", reparse: true };
        },
      };

      const failingParse = vi.fn(() => {
        throw new Error("Always fails");
      });

      const ctx = createIntermediateCall("tool", "<invalid>data</invalid>", {});
      const config: PipelineConfig = { fallbackReparse: [reparseTrigger] };

      applyHeuristicPipeline(ctx, config, {
        parse: failingParse,
        maxReparses: 1,
      });

      expect(reparseCount).toBe(1);
    });

    it("does not skip fallback-reparse if errors exist", () => {
      const fallbackSpy = vi.fn(() => ({}));
      const fallbackHeuristic: ToolCallHeuristic = {
        id: "fallback",
        phase: "fallback-reparse",
        applies: () => true,
        run: fallbackSpy,
      };

      const failingParse = vi.fn(() => {
        throw new Error("Parse failed");
      });

      const ctx = createIntermediateCall("tool", "<data></data>", {});
      const config: PipelineConfig = { fallbackReparse: [fallbackHeuristic] };

      applyHeuristicPipeline(ctx, config, { parse: failingParse });

      expect(fallbackSpy).toHaveBeenCalled();
    });

    it("does not run post-parse if parsed is null", () => {
      const postParseSpy = vi.fn(() => ({}));
      const postParseHeuristic: ToolCallHeuristic = {
        id: "post",
        phase: "post-parse",
        applies: () => true,
        run: postParseSpy,
      };

      const failingParse = vi.fn(() => {
        throw new Error("Parse failed");
      });

      const ctx = createIntermediateCall("tool", "<data></data>", {});
      const config: PipelineConfig = { postParse: [postParseHeuristic] };

      applyHeuristicPipeline(ctx, config, { parse: failingParse });

      expect(postParseSpy).not.toHaveBeenCalled();
    });
  });
});
