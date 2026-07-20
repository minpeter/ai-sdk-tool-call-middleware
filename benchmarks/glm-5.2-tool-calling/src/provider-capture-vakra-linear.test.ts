import { describe, expect, it } from "vitest";
import { credentialSafeText as credentialSafeTextBaseline } from "./provider-capture";
import { credentialSafeText } from "./provider-capture-vakra-linear";

describe("VAKRA linear provider-capture redaction", () => {
  it("preserves the baseline behavior for ordinary small inputs", () => {
    const fixtures = [
      "plain text",
      '{"api_key":"visible-secret","ok":true}',
      "Bearer visible-secret",
      "https://example.test/path?token=visible-secret&ok=1",
    ];
    for (const fixture of fixtures) {
      expect(credentialSafeText(fixture, ["visible-secret"])).toBe(
        credentialSafeTextBaseline(fixture, ["visible-secret"])
      );
    }
  });

  it("redacts a large structured request without changing safe fields", () => {
    const tools = Array.from({ length: 1024 }, (_, index) => ({
      type: "function",
      function: {
        name: `tool_${index}`,
        description: "x".repeat(1024),
        parameters: {
          type: "object",
          properties: {
            value: { type: "string" },
          },
        },
      },
    }));
    const input = JSON.stringify({
      api_key: "visible-secret",
      authorization: "Bearer visible-secret",
      callback: "https://example.test/path?token=visible-secret&ok=1",
      model: "zai-org/glm-5.2",
      tools,
    });
    expect(input.length).toBeGreaterThan(64 * 1024);

    const started = performance.now();
    const output = credentialSafeText(input, ["visible-secret"]);
    const elapsedMs = performance.now() - started;
    const parsed = JSON.parse(output) as Record<string, unknown>;

    expect(output).not.toContain("visible-secret");
    expect(parsed.api_key).toBe("[REDACTED]");
    expect(parsed.authorization).toBe("[REDACTED]");
    expect(parsed.model).toBe("zai-org/glm-5.2");
    expect(parsed.tools).toHaveLength(1024);
    expect(elapsedMs).toBeLessThan(1000);
  });
});
