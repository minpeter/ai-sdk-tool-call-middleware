import { describe, expect, it } from "vitest";
import {
  analyzeXmlFragmentForProgress,
  hasNonWhitespaceTopLevelText,
} from "../../../core/protocols/morph-xml-progress-analysis";

describe("morph XML progress fragment analysis", () => {
  it("returns top-level tag names for balanced nested and special XML", () => {
    const fragment =
      "text<!-- <ignored> --><![CDATA[<also-ignored>]]><?pi?><!DOCTYPE x>< first><nested/></ first><second />tail";

    const result = analyzeXmlFragmentForProgress(fragment);

    expect(result).toEqual({ topLevelTagNames: ["first", "second"] });
  });

  it("rejects incomplete special sections", () => {
    const fragments = ["<!--", "<![CDATA[x", "<?pi", "<!DOCTYPE x"];

    const results = fragments.map(analyzeXmlFragmentForProgress);

    expect(results).toEqual([null, null, null, null]);
  });

  it("rejects malformed tags and mismatched nesting", () => {
    const fragments = [
      "<",
      "<>",
      "</>",
      "< />",
      "<#>",
      "</orphan>",
      "<a></b>",
      "<a>",
    ];

    const results = fragments.map(analyzeXmlFragmentForProgress);

    expect(results).toEqual([null, null, null, null, null, null, null, null]);
  });

  it("accepts fragments without tags", () => {
    const result = analyzeXmlFragmentForProgress("plain text");

    expect(result).toEqual({ topLevelTagNames: [] });
  });
});

describe("morph XML top-level text detection", () => {
  it("distinguishes plain text from whitespace", () => {
    const results = ["plain", "   "].map(hasNonWhitespaceTopLevelText);

    expect(results).toEqual([true, false]);
  });

  it("finds text before and after balanced top-level tags", () => {
    const results = ["before<a/>", "<a></a>after"].map(
      hasNonWhitespaceTopLevelText
    );

    expect(results).toEqual([true, true]);
  });

  it("ignores nested text and complete special sections", () => {
    const fragments = [
      "<a>nested</a>",
      "<!-- comment --><a/>",
      "<![CDATA[text]]><a/>",
      "<?pi?><a/>",
      "<!DOCTYPE x><a/>",
    ];

    const results = fragments.map(hasNonWhitespaceTopLevelText);

    expect(results).toEqual([false, false, false, false, false]);
  });

  it("returns false for malformed and incomplete XML", () => {
    const fragments = ["<!--", "<", "</orphan>", "<a></b>", "<a>nested"];

    const results = fragments.map(hasNonWhitespaceTopLevelText);

    expect(results).toEqual([false, false, false, false, false]);
  });
});
