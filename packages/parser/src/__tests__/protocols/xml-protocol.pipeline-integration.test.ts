import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import {
  defaultPipelineConfig,
  escapeInvalidLtHeuristic,
  normalizeCloseTagsHeuristic,
  type PipelineConfig,
  repairAgainstSchemaHeuristic,
  type ToolCallHeuristic,
} from "../../core/heuristics";
import { morphXmlProtocol } from "../../core/protocols/morph-xml-protocol";

describe("morphXmlProtocol pipeline integration", () => {
  const simpleTools: LanguageModelV3FunctionTool[] = [
    {
      type: "function",
      name: "get_weather",
      inputSchema: {
        type: "object",
        properties: {
          location: { type: "string" },
        },
      },
    },
  ];

  describe("default behavior (no options)", () => {
    it("should parse valid XML without pipeline", () => {
      const protocol = morphXmlProtocol();
      const text = "<get_weather><location>Seoul</location></get_weather>";

      const result = protocol.parseGeneratedText({ text, tools: simpleTools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");
      if (result[0].type === "tool-call") {
        expect(JSON.parse(result[0].input)).toEqual({ location: "Seoul" });
      }
    });

    it("should recover malformed close tags without pipeline", () => {
      const protocol = morphXmlProtocol();
      const text = "<get_weather><location>Seoul</ location></get_weather>";

      const result = protocol.parseGeneratedText({ text, tools: simpleTools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");
    });
  });

  describe("with custom heuristics option", () => {
    it("should apply custom pre-parse heuristic", () => {
      const customHeuristic: ToolCallHeuristic = {
        id: "custom-replace",
        phase: "pre-parse",
        applies: () => true,
        run: (ctx) => ({
          rawSegment: ctx.rawSegment.replace("PLACEHOLDER", "Tokyo"),
        }),
      };

      const protocol = morphXmlProtocol({ heuristics: [customHeuristic] });
      const text =
        "<get_weather><location>PLACEHOLDER</location></get_weather>";

      const result = protocol.parseGeneratedText({ text, tools: simpleTools });

      expect(result).toHaveLength(1);
      if (result[0].type === "tool-call") {
        expect(JSON.parse(result[0].input)).toEqual({ location: "Tokyo" });
      }
    });

    it("should apply custom fallback-reparse heuristic after parse failure", () => {
      const customFallback: ToolCallHeuristic = {
        id: "custom-fallback",
        phase: "fallback-reparse",
        applies: (ctx) => ctx.errors.length > 0,
        run: (ctx) => ({
          rawSegment: ctx.rawSegment.replace("<<<BROKEN", "<location>Fixed"),
          reparse: true,
        }),
      };

      const protocol = morphXmlProtocol({ heuristics: [customFallback] });
      const text = "<get_weather><<<BROKEN</location></get_weather>";

      const result = protocol.parseGeneratedText({ text, tools: simpleTools });

      expect(result).toHaveLength(1);
      if (result[0].type === "tool-call") {
        expect(JSON.parse(result[0].input)).toEqual({ location: "Fixed" });
      }
    });

    it("should apply custom post-parse heuristic to modify parsed result", () => {
      const customPostParse: ToolCallHeuristic = {
        id: "custom-post",
        phase: "post-parse",
        applies: (ctx) => ctx.parsed !== null,
        run: (ctx) => {
          const parsed = ctx.parsed as Record<string, unknown>;
          return {
            parsed: {
              ...parsed,
              location: `${parsed.location} (modified)`,
            },
          };
        },
      };

      const protocol = morphXmlProtocol({ heuristics: [customPostParse] });
      const text = "<get_weather><location>Seoul</location></get_weather>";

      const result = protocol.parseGeneratedText({ text, tools: simpleTools });

      expect(result).toHaveLength(1);
      if (result[0].type === "tool-call") {
        expect(JSON.parse(result[0].input)).toEqual({
          location: "Seoul (modified)",
        });
      }
    });
  });

  describe("with custom pipeline option", () => {
    it("should use only specified pipeline heuristics", () => {
      const customPipeline: PipelineConfig = {
        preParse: [normalizeCloseTagsHeuristic],
        fallbackReparse: [],
        postParse: [],
      };

      const protocol = morphXmlProtocol({ pipeline: customPipeline });
      const text = "<get_weather><location>Seoul</ location></get_weather>";

      const result = protocol.parseGeneratedText({ text, tools: simpleTools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");
    });

    it("should disable fallback when fallbackReparse is empty", () => {
      const noFallbackPipeline: PipelineConfig = {
        preParse: [normalizeCloseTagsHeuristic, escapeInvalidLtHeuristic],
        fallbackReparse: [],
        postParse: [repairAgainstSchemaHeuristic],
      };

      const protocol = morphXmlProtocol({ pipeline: noFallbackPipeline });
      const text = "<get_weather><location>Seoul</get_weather>";

      const result = protocol.parseGeneratedText({ text, tools: simpleTools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("text");
    });
  });

  describe("balance -> dedupe chain (regression test)", () => {
    const shellTools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "shell",
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "array",
              items: { type: "string" },
            },
            description: { type: "string" },
          },
        },
      },
    ];

    it("should recover when balance fixes tags but creates duplicate string tags", () => {
      const protocol = morphXmlProtocol({
        pipeline: defaultPipelineConfig,
      });

      const text = `<shell>
        <command>echo "hello"</command>
        <description>First description</description>
        <description>Second description (should be removed)</description>
      </shell>`;

      const result = protocol.parseGeneratedText({ text, tools: shellTools });

      expect(result).toHaveLength(1);
      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.description).toBe(
          "Second description (should be removed)"
        );
      }
    });

    it("should handle malformed close tags with duplicate string tags", () => {
      const protocol = morphXmlProtocol({
        pipeline: defaultPipelineConfig,
      });

      const text = `<shell>
        <command>ls -la</command>
        <description>List files</ description>
        <description>Show all</description>
      </shell>`;

      const result = protocol.parseGeneratedText({ text, tools: shellTools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");
      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.description).toBe("Show all");
      }
    });
  });

  describe("maxReparses behavior", () => {
    it("should respect maxReparses limit", () => {
      let reparseCount = 0;
      const countingHeuristic: ToolCallHeuristic = {
        id: "counting",
        phase: "fallback-reparse",
        applies: () => true,
        run: () => {
          reparseCount += 1;
          return { rawSegment: "<invalid", reparse: true };
        },
      };

      const protocol = morphXmlProtocol({
        pipeline: {
          preParse: [],
          fallbackReparse: [
            countingHeuristic,
            countingHeuristic,
            countingHeuristic,
          ],
          postParse: [],
        },
      });

      const text = "<get_weather><broken</get_weather>";
      protocol.parseGeneratedText({ text, tools: simpleTools });

      expect(reparseCount).toBeLessThanOrEqual(3);
    });

    it("should use maxReparses from protocol options", () => {
      let heuristicRunCount = 0;
      const trackingHeuristic: ToolCallHeuristic = {
        id: "tracking",
        phase: "pre-parse",
        applies: () => true,
        run: (ctx) => {
          heuristicRunCount += 1;
          return { rawSegment: ctx.rawSegment };
        },
      };

      const protocolWithPipeline = morphXmlProtocol({
        pipeline: {
          preParse: [trackingHeuristic],
          fallbackReparse: [],
          postParse: [],
        },
        maxReparses: 1,
      });

      const text = "<get_weather><location>Seoul</location></get_weather>";
      protocolWithPipeline.parseGeneratedText({ text, tools: simpleTools });

      expect(heuristicRunCount).toBe(1);
    });

    it("should allow more reparses when maxReparses is increased", () => {
      let heuristicRunCount = 0;
      const trackingHeuristic: ToolCallHeuristic = {
        id: "tracking",
        phase: "pre-parse",
        applies: () => true,
        run: (ctx) => {
          heuristicRunCount += 1;
          return { rawSegment: ctx.rawSegment };
        },
      };

      const protocol = morphXmlProtocol({
        pipeline: {
          preParse: [trackingHeuristic, trackingHeuristic],
          fallbackReparse: [],
          postParse: [],
        },
        maxReparses: 3,
      });

      const text = "<get_weather><location>Seoul</location></get_weather>";
      protocol.parseGeneratedText({ text, tools: simpleTools });

      expect(heuristicRunCount).toBe(2);
    });
  });

  describe("backward compatibility with legacy code path", () => {
    it("should produce same result for valid XML with or without pipeline", () => {
      const withoutPipeline = morphXmlProtocol();
      const withPipeline = morphXmlProtocol({
        pipeline: defaultPipelineConfig,
      });

      const text = "<get_weather><location>Seoul</location></get_weather>";

      const resultWithout = withoutPipeline.parseGeneratedText({
        text,
        tools: simpleTools,
      });
      const resultWith = withPipeline.parseGeneratedText({
        text,
        tools: simpleTools,
      });

      expect(resultWithout).toHaveLength(1);
      expect(resultWith).toHaveLength(1);

      if (
        resultWithout[0].type === "tool-call" &&
        resultWith[0].type === "tool-call"
      ) {
        expect(JSON.parse(resultWithout[0].input)).toEqual(
          JSON.parse(resultWith[0].input)
        );
      }
    });

    it("should produce same result for malformed close tags", () => {
      const withoutPipeline = morphXmlProtocol();
      const withPipeline = morphXmlProtocol({
        pipeline: defaultPipelineConfig,
      });

      const text = "<get_weather><location>Seoul</ location></get_weather>";

      const resultWithout = withoutPipeline.parseGeneratedText({
        text,
        tools: simpleTools,
      });
      const resultWith = withPipeline.parseGeneratedText({
        text,
        tools: simpleTools,
      });

      expect(resultWithout[0].type).toBe("tool-call");
      expect(resultWith[0].type).toBe("tool-call");

      if (
        resultWithout[0].type === "tool-call" &&
        resultWith[0].type === "tool-call"
      ) {
        expect(JSON.parse(resultWithout[0].input)).toEqual(
          JSON.parse(resultWith[0].input)
        );
      }
    });
  });

  describe("index tags preservation", () => {
    const coordTools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "set_coordinates",
        inputSchema: {
          type: "object",
          properties: {
            coordinates: {
              type: "array",
              items: { type: "number" },
            },
          },
        },
      },
    ];

    it("should preserve <0>, <1> index tags", () => {
      const protocol = morphXmlProtocol({ pipeline: defaultPipelineConfig });
      const text = `<set_coordinates>
        <coordinates>
          <0>10.5</0>
          <1>20.3</1>
        </coordinates>
      </set_coordinates>`;

      const result = protocol.parseGeneratedText({ text, tools: coordTools });

      expect(result).toHaveLength(1);
      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.coordinates).toEqual([10.5, 20.3]);
      }
    });
  });
});
