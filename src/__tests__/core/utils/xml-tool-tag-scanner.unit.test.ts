import { describe, expect, it } from "vitest";
import {
  findEarliestToolTag,
  findNextToolTag,
  findSelfClosingTag,
  getSelfClosingTagPattern,
} from "../../../core/utils/xml-tool-tag-scanner";

describe("xml-tool-tag-scanner", () => {
  it("caches self-closing tag patterns by tool name", () => {
    const first = getSelfClosingTagPattern("weather");
    const second = getSelfClosingTagPattern("weather");
    expect(first).toBe(second);
  });

  it("findSelfClosingTag finds the next self-closing tag from index", () => {
    const text = "start <weather/> mid <weather /> end";
    const first = findSelfClosingTag(text, "weather", 0);
    const second = findSelfClosingTag(text, "weather", (first?.index ?? 0) + 1);

    expect(first).toEqual({ index: 6, length: 10 });
    expect(second).toEqual({ index: 21, length: 11 });
  });

  it("findNextToolTag prefers earlier self-closing tag", () => {
    const text = "x <weather/> y <weather>z</weather>";
    const match = findNextToolTag(text, 0, "weather");

    expect(match).toEqual({
      tagStart: 2,
      isSelfClosing: true,
      tagLength: 10,
    });
  });

  it("findNextToolTag prefers earlier open tag", () => {
    const text = "x <weather>z</weather> y <weather/>";
    const match = findNextToolTag(text, 0, "weather");

    expect(match).toEqual({
      tagStart: 2,
      isSelfClosing: false,
      tagLength: 9,
    });
  });

  it("findEarliestToolTag scans across multiple tool names", () => {
    const buffer = ".. <calc/> .. <weather>";
    const result = findEarliestToolTag(buffer, ["weather", "calc"]);

    expect(result).toEqual({
      index: 3,
      name: "calc",
      selfClosing: true,
      tagLength: 7,
    });
  });

  it("findEarliestToolTag returns not-found when no tag exists", () => {
    const result = findEarliestToolTag("plain text", ["weather"]);

    expect(result).toEqual({
      index: -1,
      name: "",
      selfClosing: false,
      tagLength: 0,
    });
  });
});
