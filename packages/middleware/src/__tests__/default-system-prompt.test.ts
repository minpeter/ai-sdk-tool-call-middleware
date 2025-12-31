import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Prompt,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { defaultSystemPromptMiddleware } from "../default-system-prompt";

function callTransform(
  mw: ReturnType<typeof defaultSystemPromptMiddleware>,
  prompt: LanguageModelV3Prompt
) {
  const transform = mw.transformParams;
  if (!transform) {
    throw new Error("transformParams is undefined");
  }
  return transform({
    params: { prompt } as unknown as LanguageModelV3CallOptions,
  } as any);
}

describe("defaultSystemPromptMiddleware placement", () => {
  it("first: adds at beginning when missing system", async () => {
    const mw = defaultSystemPromptMiddleware({
      systemPrompt: "SYS",
      placement: "first",
    });
    const out = await callTransform(mw, [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ] as any);
    expect(out.prompt[0].role).toBe("system");
    expect(String(out.prompt[0].content)).toContain("SYS");
  });

  it("last: appends at end when missing system", async () => {
    const mw = defaultSystemPromptMiddleware({
      systemPrompt: "SYS",
      placement: "last",
    });
    const out = await callTransform(mw, [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ] as any);
    expect(out.prompt.at(-1)?.role).toBe("system");
    expect(String(out.prompt.at(-1)?.content)).toContain("SYS");
  });

  it("first: merges before existing system content", async () => {
    const mw = defaultSystemPromptMiddleware({
      systemPrompt: "ADD",
      placement: "first",
    });
    const out = await callTransform(mw, [
      { role: "system", content: "BASE" },
    ] as any);
    const text = String(out.prompt[0].content);
    expect(text.startsWith("ADD\n\nBASE")).toBe(true);
  });

  it("last: merges after existing system content", async () => {
    const mw = defaultSystemPromptMiddleware({
      systemPrompt: "ADD",
      placement: "last",
    });
    const out = await callTransform(mw, [
      { role: "system", content: "BASE" },
    ] as any);
    const text = String(out.prompt[0].content);
    expect(text.endsWith("BASE\n\nADD")).toBe(true);
  });
});
