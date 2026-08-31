import { describe, expect, it } from "vitest";
import { isDefinitelyPlainGlm5Text } from "../../../core/protocols/glm5-fast-path-registry";

describe("GLM-5 plain-text fast-path guard", () => {
  it.each([
    "",
    " \t\n",
    "<tool_call>weather",
    '{ "name": "weather", "arguments": {} }',
    '[{ "name": "weather", "arguments": {} }]',
    'weather(city="Paris")',
    'weather(city="Paris");',
    'weather(city="Paris");\u00a0',
  ])("defers tool-call-shaped text to the complete parser: %j", (text) => {
    expect(isDefinitelyPlainGlm5Text(text)).toBe(false);
  });

  it.each([
    "The weather is sunny.",
    "No tools are needed",
    "A semicolon in prose; remains plain",
    "Unicode text: 서울의 날씨",
  ])("accepts unambiguous plain text: %j", (text) => {
    expect(isDefinitelyPlainGlm5Text(text)).toBe(true);
  });
});
