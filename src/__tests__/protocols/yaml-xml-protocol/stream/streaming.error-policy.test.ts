import { describe, expect, it, vi } from "vitest";
import type { ParserOptions } from "../../../../core/protocols/protocol-interface";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import {
  collectTextDeltas,
  parseToolCallObject,
  requireToolCall,
  runProtocolTextStream,
} from "../../shared/duplicate-harness";
import { basicTools } from "../parse-generated-text/shared";

const malformedClosedCall = "<get_weather>\n[invalid: yaml:\n</get_weather>";

function runErrorStream(text: string, options?: ParserOptions) {
  return runProtocolTextStream({
    protocol: yamlXmlProtocol(),
    tools: basicTools,
    id: "1",
    chunks: [text],
    parserOptions: options,
  });
}

describe("yamlXmlProtocol streaming error policy", () => {
  it("should suppress raw tool markup on YAML parse error by default", async () => {
    const onError = vi.fn();
    const out = await runErrorStream(malformedClosedCall, { onError });
    const text = collectTextDeltas(out);
    expect(text).not.toContain("<get_weather>");
    expect(text).not.toContain("</get_weather>");
    expect(onError).toHaveBeenCalled();
  });

  it("should allow raw fallback text when explicitly enabled", async () => {
    const out = await runErrorStream(malformedClosedCall, {
      emitRawToolCallTextOnError: true,
    });
    const text = collectTextDeltas(out);
    expect(text).toContain("<get_weather>");
    expect(text).toContain("</get_weather>");
  });

  it("passes structured drop metadata when unclosed YAML tool call is not parseable at finish", async () => {
    const onError = vi.fn();
    await runErrorStream("<get_weather>\n[invalid: yaml:", { onError });
    const finishErrorCall = onError.mock.calls.find(([message]) =>
      String(message).includes("Could not complete streaming YAML tool call")
    );
    expect(finishErrorCall).toBeDefined();
    const metadata = finishErrorCall?.[1];
    expect(metadata).toMatchObject({
      toolName: "get_weather",
      dropReason: "unfinished-tool-call",
    });
    expect(typeof metadata?.toolCallId).toBe("string");
    expect(metadata?.toolCall).toContain("<get_weather>");
  });

  it("should force-complete incomplete tool call on finish when parseable", async () => {
    const out = await runErrorStream("<get_weather>\nlocation: Incomplete");
    const toolCall = requireToolCall(out);
    expect(toolCall.toolName).toBe("get_weather");
    expect(parseToolCallObject(toolCall)).toEqual({ location: "Incomplete" });
  });
});
