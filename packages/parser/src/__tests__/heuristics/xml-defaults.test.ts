import { describe, expect, it } from "vitest";
import {
  balanceTags,
  balanceTagsHeuristic,
  createIntermediateCall,
  dedupeShellStringTagsHeuristic,
  dedupeSingleTag,
  defaultPipelineConfig,
  escapeInvalidLt,
  escapeInvalidLtHeuristic,
  getStringPropertyNames,
  normalizeCloseTagsHeuristic,
  repairAgainstSchemaHeuristic,
  repairParsedAgainstSchema,
  shouldDeduplicateStringTags,
} from "../../core/heuristics";

describe("default-heuristics", () => {
  describe("normalizeCloseTagsHeuristic", () => {
    it("has correct id and phase", () => {
      expect(normalizeCloseTagsHeuristic.id).toBe("normalize-close-tags");
      expect(normalizeCloseTagsHeuristic.phase).toBe("pre-parse");
    });

    it("always applies", () => {
      const ctx = createIntermediateCall("tool", "<data></data>", {});
      expect(normalizeCloseTagsHeuristic.applies(ctx)).toBe(true);
    });

    it("normalizes malformed close tags", () => {
      const ctx = createIntermediateCall("tool", "<tag>content</ tag>", {});
      const result = normalizeCloseTagsHeuristic.run(ctx);
      expect(result.rawSegment).toBe("<tag>content</tag>");
    });

    it("returns empty object when no changes needed", () => {
      const ctx = createIntermediateCall("tool", "<tag>content</tag>", {});
      const result = normalizeCloseTagsHeuristic.run(ctx);
      expect(result).toEqual({});
    });
  });

  describe("escapeInvalidLtHeuristic", () => {
    it("has correct id and phase", () => {
      expect(escapeInvalidLtHeuristic.id).toBe("escape-invalid-lt");
      expect(escapeInvalidLtHeuristic.phase).toBe("pre-parse");
    });

    it("escapes invalid < characters", () => {
      const ctx = createIntermediateCall("tool", "<tag>a < b</tag>", {});
      const result = escapeInvalidLtHeuristic.run(ctx);
      expect(result.rawSegment).toBe("<tag>a &lt; b</tag>");
    });

    it("preserves valid XML tags", () => {
      const ctx = createIntermediateCall(
        "tool",
        "<tag><nested>value</nested></tag>",
        {}
      );
      const result = escapeInvalidLtHeuristic.run(ctx);
      expect(result).toEqual({});
    });
  });

  describe("balanceTagsHeuristic", () => {
    it("has correct id and phase", () => {
      expect(balanceTagsHeuristic.id).toBe("balance-tags");
      expect(balanceTagsHeuristic.phase).toBe("fallback-reparse");
    });

    it("requests reparse when tags are balanced", () => {
      const ctx = createIntermediateCall("tool", "<tag><nested>value</tag>", {
        type: "object",
      });
      ctx.meta = { originalContent: "<tag><nested>value</tag>" };

      if (balanceTagsHeuristic.applies(ctx)) {
        const result = balanceTagsHeuristic.run(ctx);
        expect(result.reparse).toBe(true);
        expect(result.rawSegment).toContain("</nested>");
      }
    });
  });

  describe("dedupeShellStringTagsHeuristic", () => {
    it("has correct id and phase", () => {
      expect(dedupeShellStringTagsHeuristic.id).toBe(
        "dedupe-shell-string-tags"
      );
      expect(dedupeShellStringTagsHeuristic.phase).toBe("fallback-reparse");
    });

    it("applies only for shell-like schemas with command array", () => {
      const shellSchema = {
        type: "object",
        properties: {
          command: { type: "array", items: { type: "string" } },
        },
      };
      const ctx = createIntermediateCall("shell", "<data></data>", shellSchema);
      expect(dedupeShellStringTagsHeuristic.applies(ctx)).toBe(true);

      const nonShellSchema = {
        type: "object",
        properties: { foo: { type: "string" } },
      };
      const ctx2 = createIntermediateCall(
        "tool",
        "<data></data>",
        nonShellSchema
      );
      expect(dedupeShellStringTagsHeuristic.applies(ctx2)).toBe(false);
    });
  });

  describe("repairAgainstSchemaHeuristic", () => {
    it("has correct id and phase", () => {
      expect(repairAgainstSchemaHeuristic.id).toBe("repair-against-schema");
      expect(repairAgainstSchemaHeuristic.phase).toBe("post-parse");
    });

    it("applies only when parsed is not null and is object", () => {
      const ctx1 = createIntermediateCall("tool", "<data></data>", {});
      ctx1.parsed = { value: 1 };
      expect(repairAgainstSchemaHeuristic.applies(ctx1)).toBe(true);

      const ctx2 = createIntermediateCall("tool", "<data></data>", {});
      ctx2.parsed = null;
      expect(repairAgainstSchemaHeuristic.applies(ctx2)).toBe(false);

      const ctx3 = createIntermediateCall("tool", "<data></data>", {});
      ctx3.parsed = "string";
      expect(repairAgainstSchemaHeuristic.applies(ctx3)).toBe(false);
    });
  });

  describe("defaultPipelineConfig", () => {
    it("has all three phases configured", () => {
      expect(defaultPipelineConfig.preParse).toBeDefined();
      expect(defaultPipelineConfig.fallbackReparse).toBeDefined();
      expect(defaultPipelineConfig.postParse).toBeDefined();
    });

    it("includes normalizeCloseTags and escapeInvalidLt in preParse", () => {
      const ids = defaultPipelineConfig.preParse?.map((h) => h.id) ?? [];
      expect(ids).toContain("normalize-close-tags");
      expect(ids).toContain("escape-invalid-lt");
    });

    it("includes balanceTags and dedupeShellStringTags in fallbackReparse", () => {
      const ids = defaultPipelineConfig.fallbackReparse?.map((h) => h.id) ?? [];
      expect(ids).toContain("balance-tags");
      expect(ids).toContain("dedupe-shell-string-tags");
    });

    it("includes repairAgainstSchema in postParse", () => {
      const ids = defaultPipelineConfig.postParse?.map((h) => h.id) ?? [];
      expect(ids).toContain("repair-against-schema");
    });
  });

  describe("escapeInvalidLt utility", () => {
    it("escapes < not followed by valid NameStartChar", () => {
      expect(escapeInvalidLt("a < b")).toBe("a &lt; b");
      // Per XML 1.0 spec, NameStartChar does NOT include digits
      // So <2 is escaped because 2 is not a valid tag start
      expect(escapeInvalidLt("1<2")).toBe("1&lt;2");
    });

    it("escapes < followed by non-NameStartChar characters", () => {
      // Dot and hyphen - valid in NameChar but NOT in NameStartChar
      expect(escapeInvalidLt("x<.y")).toBe("x&lt;.y");
      expect(escapeInvalidLt("a<-b")).toBe("a&lt;-b");

      // Empty/EOF after <
      expect(escapeInvalidLt("test<")).toBe("test&lt;");
    });

    it("preserves valid XML tags", () => {
      expect(escapeInvalidLt("<tag>")).toBe("<tag>");
      expect(escapeInvalidLt("</tag>")).toBe("</tag>");
      expect(escapeInvalidLt("<!DOCTYPE>")).toBe("<!DOCTYPE>");
      expect(escapeInvalidLt("<?xml?>")).toBe("<?xml?>");
    });

    it("preserves tags starting with NameStartChar (letters, underscore, colon)", () => {
      expect(escapeInvalidLt("<_private>")).toBe("<_private>");
      expect(escapeInvalidLt("<:namespaced>")).toBe("<:namespaced>");
      expect(escapeInvalidLt("<ABC>")).toBe("<ABC>");
      expect(escapeInvalidLt("<abc123>")).toBe("<abc123>"); // digits OK after first char
    });

    it("handles mixed content with valid and invalid <", () => {
      expect(escapeInvalidLt("<tag>1 < 2 and 3 > 1</tag>")).toBe(
        "<tag>1 &lt; 2 and 3 > 1</tag>"
      );
      expect(escapeInvalidLt("if (x<2 && y>3) { <action/> }")).toBe(
        "if (x&lt;2 && y>3) { <action/> }"
      );
    });

    it("preserves index tags (<0>, <1>, etc.) used for tuple/array representation", () => {
      expect(escapeInvalidLt("<0>10.5</0>")).toBe("<0>10.5</0>");
      expect(escapeInvalidLt("<1>20.3</1>")).toBe("<1>20.3</1>");
      expect(escapeInvalidLt("<12/>")).toBe("<12/>");
      expect(
        escapeInvalidLt("<coordinates><0>10</0><1>20</1></coordinates>")
      ).toBe("<coordinates><0>10</0><1>20</1></coordinates>");
    });

    it("escapes digit-start that is NOT an index tag pattern", () => {
      expect(escapeInvalidLt("<0abc")).toBe("&lt;0abc");
      expect(escapeInvalidLt("x<9y")).toBe("x&lt;9y");
      expect(escapeInvalidLt("<2 ")).toBe("&lt;2 ");
    });
  });

  describe("balanceTags utility", () => {
    it("closes unclosed tags", () => {
      expect(balanceTags("<tag>content")).toBe("<tag>content</tag>");
    });

    it("handles nested unclosed tags", () => {
      const result = balanceTags("<outer><inner>text</outer>");
      expect(result).toContain("</inner>");
      expect(result).toContain("</outer>");
    });

    it("preserves well-formed XML", () => {
      const xml = "<tag><nested>value</nested></tag>";
      expect(balanceTags(xml)).toBe(xml);
    });
  });

  describe("shouldDeduplicateStringTags utility", () => {
    it("returns true for schemas with command array property", () => {
      const schema = {
        type: "object",
        properties: {
          command: { type: "array", items: { type: "string" } },
        },
      };
      expect(shouldDeduplicateStringTags(schema)).toBe(true);
    });

    it("returns false for non-array command", () => {
      const schema = {
        type: "object",
        properties: {
          command: { type: "string" },
        },
      };
      expect(shouldDeduplicateStringTags(schema)).toBe(false);
    });

    it("returns false when no command property", () => {
      const schema = {
        type: "object",
        properties: {
          foo: { type: "string" },
        },
      };
      expect(shouldDeduplicateStringTags(schema)).toBe(false);
    });
  });

  describe("getStringPropertyNames utility", () => {
    it("extracts string property names from schema", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
          email: { type: "string" },
        },
      };
      const names = getStringPropertyNames(schema);
      expect(names).toContain("name");
      expect(names).toContain("email");
      expect(names).not.toContain("age");
    });

    it("returns empty array for null/undefined schema", () => {
      expect(getStringPropertyNames(null)).toEqual([]);
      expect(getStringPropertyNames(undefined)).toEqual([]);
    });
  });

  describe("dedupeSingleTag utility", () => {
    it("keeps only last occurrence of duplicate tags", () => {
      const xml = "<key>first</key><other/><key>second</key>";
      expect(dedupeSingleTag(xml, "key")).toBe("<other/><key>second</key>");
    });

    it("returns unchanged when only one occurrence", () => {
      const xml = "<key>value</key>";
      expect(dedupeSingleTag(xml, "key")).toBe(xml);
    });

    it("returns unchanged when tag not found", () => {
      const xml = "<other>value</other>";
      expect(dedupeSingleTag(xml, "key")).toBe(xml);
    });
  });

  describe("repairParsedAgainstSchema utility", () => {
    it("returns input unchanged when not object", () => {
      expect(repairParsedAgainstSchema(null, {})).toBeNull();
      expect(repairParsedAgainstSchema("string", {})).toBe("string");
      expect(repairParsedAgainstSchema(123, {})).toBe(123);
    });

    it("returns input unchanged when schema has no properties", () => {
      const input = { foo: "bar" };
      expect(repairParsedAgainstSchema(input, {})).toEqual(input);
    });
  });
});
