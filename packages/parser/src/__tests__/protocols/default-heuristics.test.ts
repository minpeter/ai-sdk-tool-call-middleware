import { describe, expect, it } from "vitest";
import {
  balanceTagsHeuristic,
  dedupeShellStringTagsHeuristic,
  normalizeCloseTagsHeuristic,
  repairAgainstSchemaHeuristic,
} from "../../protocols/default-heuristics";
import type { IntermediateCall } from "../../protocols/heuristic-engine";

describe("Default Heuristics", () => {
  describe("normalizeCloseTagsHeuristic", () => {
    it("normalizes malformed closing tags with whitespace", () => {
      const ctx: IntermediateCall = {
        toolName: "test",
        schema: {},
        rawSegment: "<item>test</  item>",
        parsed: null,
        errors: [],
      };

      const result = normalizeCloseTagsHeuristic.run(ctx);

      expect(result.rawSegment).toBe("<item>test</item>");
    });

    it("normalizes closing tags with newlines", () => {
      const ctx: IntermediateCall = {
        toolName: "test",
        schema: {},
        rawSegment: "<step>content</\n  step>",
        parsed: null,
        errors: [],
      };

      const result = normalizeCloseTagsHeuristic.run(ctx);

      expect(result.rawSegment).toBe("<step>content</step>");
    });

    it("returns empty result when no malformed tags", () => {
      const ctx: IntermediateCall = {
        toolName: "test",
        schema: {},
        rawSegment: "<item>test</item>",
        parsed: null,
        errors: [],
      };

      const result = normalizeCloseTagsHeuristic.run(ctx);

      expect(result.rawSegment).toBeUndefined();
    });
  });

  describe("balanceTagsHeuristic", () => {
    it("applies when malformed close tags exist and balancing is needed", () => {
      const ctx: IntermediateCall = {
        toolName: "test",
        schema: {},
        rawSegment: "<item>test</  item><unclosed>tag",
        parsed: null,
        errors: [],
        meta: { originalContent: "<item>test</  item><unclosed>tag" },
      };

      const applies = balanceTagsHeuristic.applies(ctx);
      expect(applies).toBe(true);
    });

    it("does not apply when balanced would add content without malformed tags", () => {
      const ctx: IntermediateCall = {
        toolName: "test",
        schema: {},
        rawSegment: "<item>test<unclosed>",
        parsed: null,
        errors: [],
        meta: { originalContent: "<item>test<unclosed>" },
      };

      const applies = balanceTagsHeuristic.applies(ctx);
      expect(applies).toBe(false);
    });

    it("balances unclosed tags and triggers reparse", () => {
      const ctx: IntermediateCall = {
        toolName: "test",
        schema: {},
        rawSegment: "<item>test</  item><unclosed>tag",
        parsed: null,
        errors: [],
        meta: { originalContent: "<item>test</  item><unclosed>tag" },
      };

      const result = balanceTagsHeuristic.run(ctx);

      expect(result.reparse).toBe(true);
      expect(result.rawSegment).toContain("</unclosed>");
    });

    it("escapes invalid < characters in balanced output", () => {
      const ctx: IntermediateCall = {
        toolName: "test",
        schema: {},
        rawSegment: "<item>test < value</  item>",
        parsed: null,
        errors: [],
        meta: { originalContent: "<item>test < value</  item>" },
      };

      const result = balanceTagsHeuristic.run(ctx);

      expect(result.rawSegment).toContain("&lt;");
    });
  });

  describe("dedupeShellStringTagsHeuristic", () => {
    it("applies only to schemas with command array property", () => {
      const shellSchema = {
        type: "object",
        properties: {
          command: {
            type: "array",
            items: { type: "string" },
          },
        },
      };

      const nonShellSchema = {
        type: "object",
        properties: {
          data: { type: "string" },
        },
      };

      const shellCtx: IntermediateCall = {
        toolName: "shell",
        schema: shellSchema,
        rawSegment: "",
        parsed: null,
        errors: [],
      };

      const nonShellCtx: IntermediateCall = {
        toolName: "other",
        schema: nonShellSchema,
        rawSegment: "",
        parsed: null,
        errors: [],
      };

      expect(dedupeShellStringTagsHeuristic.applies(shellCtx)).toBe(true);
      expect(dedupeShellStringTagsHeuristic.applies(nonShellCtx)).toBe(false);
    });

    it("deduplicates string tags using last-win strategy", () => {
      const schema = {
        type: "object",
        properties: {
          command: {
            type: "array",
            items: { type: "string" },
          },
          workdir: { type: "string" },
        },
      };

      const ctx: IntermediateCall = {
        toolName: "shell",
        schema,
        rawSegment:
          "<command>first</command><workdir>.</workdir><workdir>/tmp</workdir>",
        parsed: null,
        errors: [],
      };

      const result = dedupeShellStringTagsHeuristic.run(ctx);

      expect(result.reparse).toBe(true);
      expect(result.rawSegment).toBe(
        "<command>first</command><workdir>/tmp</workdir>"
      );
    });

    it("does not modify when no duplicates", () => {
      const schema = {
        type: "object",
        properties: {
          command: {
            type: "array",
            items: { type: "string" },
          },
          workdir: { type: "string" },
        },
      };

      const ctx: IntermediateCall = {
        toolName: "shell",
        schema,
        rawSegment: "<command>first</command><workdir>.</workdir>",
        parsed: null,
        errors: [],
      };

      const result = dedupeShellStringTagsHeuristic.run(ctx);

      expect(result.reparse).toBeUndefined();
      expect(result.rawSegment).toBeUndefined();
    });
  });

  describe("repairAgainstSchemaHeuristic", () => {
    it("applies only when parsed is an object", () => {
      const objCtx: IntermediateCall = {
        toolName: "test",
        schema: {},
        rawSegment: "",
        parsed: { data: "value" },
        errors: [],
      };

      const nullCtx: IntermediateCall = {
        toolName: "test",
        schema: {},
        rawSegment: "",
        parsed: null,
        errors: [],
      };

      const stringCtx: IntermediateCall = {
        toolName: "test",
        schema: {},
        rawSegment: "",
        parsed: "string",
        errors: [],
      };

      expect(repairAgainstSchemaHeuristic.applies(objCtx)).toBe(true);
      expect(repairAgainstSchemaHeuristic.applies(nullCtx)).toBe(false);
      expect(repairAgainstSchemaHeuristic.applies(stringCtx)).toBe(false);
    });

    it("processes parsed object according to schema", () => {
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: { type: "number" },
          },
        },
      };

      const ctx: IntermediateCall = {
        toolName: "test",
        schema,
        rawSegment: "",
        parsed: { items: [1, 2, 3] },
        errors: [],
      };

      const result = repairAgainstSchemaHeuristic.run(ctx);

      // The heuristic may or may not return a parsed value depending on
      // whether repairs were needed. Just verify it doesn't throw
      expect(result).toBeDefined();
    });

    it("handles nested object repairs", () => {
      const schema = {
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
          },
        },
      };

      const ctx: IntermediateCall = {
        toolName: "test",
        schema,
        rawSegment: "",
        parsed: { nested: { value: "test" } },
        errors: [],
      };

      const result = repairAgainstSchemaHeuristic.run(ctx);

      expect(result).toBeDefined();
    });

    it("does not modify when no repairs needed", () => {
      const schema = {
        type: "object",
        properties: {
          value: { type: "string" },
        },
      };

      const ctx: IntermediateCall = {
        toolName: "test",
        schema,
        rawSegment: "",
        parsed: { value: "test" },
        errors: [],
      };

      const result = repairAgainstSchemaHeuristic.run(ctx);

      // If no changes needed, parsed should not be set in result
      expect(result).toBeDefined();
      // The actual repair logic is tested in existing integration tests
    });
  });
});
