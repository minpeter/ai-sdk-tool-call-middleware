import { describe, expect, it } from "vitest";
import {
  applyHeuristicPipeline,
  type IntermediateCall,
  type PipelineConfig,
  type ToolCallHeuristic,
} from "../../protocols/heuristic-engine";

describe("Heuristic Engine", () => {
  const mockParse = (xml: string, _schema: unknown) => {
    if (xml.includes("FAIL")) {
      throw new Error("Parse failed");
    }
    return { parsed: xml };
  };

  describe("Phase execution order", () => {
    it("executes heuristics in correct phase order", () => {
      const executionOrder: string[] = [];

      const preParseHeuristic: ToolCallHeuristic = {
        id: "pre-parse-test",
        phase: "pre-parse",
        applies: () => true,
        run: () => {
          executionOrder.push("pre-parse");
          return {};
        },
      };

      const fallbackHeuristic: ToolCallHeuristic = {
        id: "fallback-test",
        phase: "fallback-reparse",
        applies: () => true,
        run: () => {
          executionOrder.push("fallback-reparse");
          return {};
        },
      };

      const postParseHeuristic: ToolCallHeuristic = {
        id: "post-parse-test",
        phase: "post-parse",
        applies: () => true,
        run: () => {
          executionOrder.push("post-parse");
          return {};
        },
      };

      const config: PipelineConfig = {
        preParse: [preParseHeuristic],
        fallbackReparse: [fallbackHeuristic],
        postParse: [postParseHeuristic],
      };

      const ctx: IntermediateCall = {
        toolName: "test",
        schema: {},
        rawSegment: "test",
        parsed: null,
        errors: [],
      };

      applyHeuristicPipeline(ctx, config, { parse: mockParse });

      // Pre-parse should run, then parse succeeds, then post-parse runs
      // Fallback should NOT run since parse succeeded
      expect(executionOrder).toEqual(["pre-parse", "post-parse"]);
    });

    it("runs fallback-reparse only when initial parse fails", () => {
      const executionOrder: string[] = [];

      const fallbackHeuristic: ToolCallHeuristic = {
        id: "fallback-test",
        phase: "fallback-reparse",
        applies: () => true,
        run: (_ctx) => {
          executionOrder.push("fallback-reparse");
          // Fix the content so reparse succeeds
          return { rawSegment: "FIXED", reparse: true };
        },
      };

      const config: PipelineConfig = {
        fallbackReparse: [fallbackHeuristic],
      };

      const ctx: IntermediateCall = {
        toolName: "test",
        schema: {},
        rawSegment: "FAIL",
        parsed: null,
        errors: [],
      };

      const result = applyHeuristicPipeline(ctx, config, { parse: mockParse });

      expect(executionOrder).toContain("fallback-reparse");
      expect(result.parsed).toEqual({ parsed: "FIXED" });
    });
  });

  describe("Heuristic result handling", () => {
    it("updates rawSegment when heuristic returns new segment", () => {
      const heuristic: ToolCallHeuristic = {
        id: "update-segment",
        phase: "pre-parse",
        applies: () => true,
        run: () => ({ rawSegment: "UPDATED" }),
      };

      const config: PipelineConfig = {
        preParse: [heuristic],
      };

      const ctx: IntermediateCall = {
        toolName: "test",
        schema: {},
        rawSegment: "ORIGINAL",
        parsed: null,
        errors: [],
      };

      const result = applyHeuristicPipeline(ctx, config, { parse: mockParse });

      expect(result.parsed).toEqual({ parsed: "UPDATED" });
    });

    it("updates parsed when heuristic returns new parsed object", () => {
      const heuristic: ToolCallHeuristic = {
        id: "update-parsed",
        phase: "post-parse",
        applies: () => true,
        run: () => ({ parsed: { custom: "value" } }),
      };

      const config: PipelineConfig = {
        postParse: [heuristic],
      };

      const ctx: IntermediateCall = {
        toolName: "test",
        schema: {},
        rawSegment: "test",
        parsed: null,
        errors: [],
      };

      const result = applyHeuristicPipeline(ctx, config, { parse: mockParse });

      expect(result.parsed).toEqual({ custom: "value" });
    });

    it("triggers reparse when heuristic requests it", () => {
      const heuristic: ToolCallHeuristic = {
        id: "reparse-request",
        phase: "fallback-reparse",
        applies: () => true,
        run: () => ({
          rawSegment: "FIXED",
          reparse: true,
        }),
      };

      const config: PipelineConfig = {
        fallbackReparse: [heuristic],
      };

      const ctx: IntermediateCall = {
        toolName: "test",
        schema: {},
        rawSegment: "FAIL",
        parsed: null,
        errors: [],
      };

      const result = applyHeuristicPipeline(ctx, config, { parse: mockParse });

      expect(result.parsed).toEqual({ parsed: "FIXED" });
      expect(result.errors).toHaveLength(0);
    });

    it("stops processing when heuristic returns stop=true", () => {
      const executionOrder: string[] = [];

      const stopHeuristic: ToolCallHeuristic = {
        id: "stop-early",
        phase: "pre-parse",
        applies: () => true,
        run: () => {
          executionOrder.push("stop");
          return { stop: true };
        },
      };

      const laterHeuristic: ToolCallHeuristic = {
        id: "after-stop",
        phase: "pre-parse",
        applies: () => true,
        run: () => {
          executionOrder.push("after");
          return {};
        },
      };

      const config: PipelineConfig = {
        preParse: [stopHeuristic, laterHeuristic],
      };

      const ctx: IntermediateCall = {
        toolName: "test",
        schema: {},
        rawSegment: "test",
        parsed: null,
        errors: [],
      };

      applyHeuristicPipeline(ctx, config, { parse: mockParse });

      expect(executionOrder).toEqual(["stop"]);
    });

    it("collects warnings from heuristics", () => {
      const heuristic: ToolCallHeuristic = {
        id: "warning-test",
        phase: "pre-parse",
        applies: () => true,
        run: () => ({
          warnings: ["Warning 1", "Warning 2"],
        }),
      };

      const config: PipelineConfig = {
        preParse: [heuristic],
      };

      const ctx: IntermediateCall = {
        toolName: "test",
        schema: {},
        rawSegment: "test",
        parsed: null,
        errors: [],
      };

      const result = applyHeuristicPipeline(ctx, config, { parse: mockParse });

      expect(result.meta?.warnings).toEqual(["Warning 1", "Warning 2"]);
    });
  });

  describe("Heuristic applies() gating", () => {
    it("skips heuristics that don't apply", () => {
      let executed = false;

      const heuristic: ToolCallHeuristic = {
        id: "conditional",
        phase: "pre-parse",
        applies: (_callCtx) => ctx.rawSegment.includes("TARGET"),
        run: () => {
          executed = true;
          return {};
        },
      };

      const config: PipelineConfig = {
        preParse: [heuristic],
      };

      const ctx: IntermediateCall = {
        toolName: "test",
        schema: {},
        rawSegment: "NO_MATCH",
        parsed: null,
        errors: [],
      };

      applyHeuristicPipeline(ctx, config, { parse: mockParse });

      expect(executed).toBe(false);
    });

    it("executes heuristics that apply", () => {
      let executed = false;

      const heuristic: ToolCallHeuristic = {
        id: "conditional",
        phase: "pre-parse",
        applies: (_callCtx) => ctx.rawSegment.includes("TARGET"),
        run: () => {
          executed = true;
          return {};
        },
      };

      const config: PipelineConfig = {
        preParse: [heuristic],
      };

      const ctx: IntermediateCall = {
        toolName: "test",
        schema: {},
        rawSegment: "TARGET",
        parsed: null,
        errors: [],
      };

      applyHeuristicPipeline(ctx, config, { parse: mockParse });

      expect(executed).toBe(true);
    });
  });

  describe("Error handling", () => {
    it("captures parse errors in fallback phase", () => {
      const config: PipelineConfig = {
        fallbackReparse: [],
      };

      const ctx: IntermediateCall = {
        toolName: "test",
        schema: {},
        rawSegment: "FAIL",
        parsed: null,
        errors: [],
      };

      const result = applyHeuristicPipeline(ctx, config, { parse: mockParse });

      expect(result.parsed).toBe(null);
      expect(result.errors).toHaveLength(1);
    });

    it("clears errors after successful reparse", () => {
      const heuristic: ToolCallHeuristic = {
        id: "fix-error",
        phase: "fallback-reparse",
        applies: () => true,
        run: () => ({
          rawSegment: "FIXED",
          reparse: true,
        }),
      };

      const config: PipelineConfig = {
        fallbackReparse: [heuristic],
      };

      const ctx: IntermediateCall = {
        toolName: "test",
        schema: {},
        rawSegment: "FAIL",
        parsed: null,
        errors: [],
      };

      const result = applyHeuristicPipeline(ctx, config, { parse: mockParse });

      expect(result.parsed).toEqual({ parsed: "FIXED" });
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("Empty pipeline", () => {
    it("handles empty pipeline configuration", () => {
      const config: PipelineConfig = {};

      const ctx: IntermediateCall = {
        toolName: "test",
        schema: {},
        rawSegment: "test",
        parsed: null,
        errors: [],
      };

      const result = applyHeuristicPipeline(ctx, config, { parse: mockParse });

      expect(result.parsed).toEqual({ parsed: "test" });
    });
  });
});
