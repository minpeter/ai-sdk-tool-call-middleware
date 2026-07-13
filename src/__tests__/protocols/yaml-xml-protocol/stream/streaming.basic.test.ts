import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";
import { basicTools } from "../parse-generated-text/shared";

describe("yamlXmlProtocol streaming basic", () => {
  it("should parse a complete tool call in a single chunk", async () => {
    const protocol = yamlXmlProtocol();
    const transformer = protocol.createStreamParser({ tools: basicTools });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: `<get_weather>
location: London
unit: celsius
</get_weather>`,
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });

    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const tool = out.find((c) => c.type === "tool-call") as {
      toolName: string;
      input: string;
    };
    expect(tool.toolName).toBe("get_weather");
    const args = JSON.parse(tool.input);
    expect(args.location).toBe("London");
    expect(args.unit).toBe("celsius");
  });

  it("should parse tool call split across multiple chunks", async () => {
    const protocol = yamlXmlProtocol();
    const transformer = protocol.createStreamParser({ tools: basicTools });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "<get_wea" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "ther>\n" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "location: Ber" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "lin\n" });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "</get_weather>",
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });

    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const tool = out.find((c) => c.type === "tool-call") as {
      toolName: string;
      input: string;
    };
    expect(tool.toolName).toBe("get_weather");
    const args = JSON.parse(tool.input);
    expect(args.location).toBe("Berlin");
  });

  it("keeps a partial tool tag buffered across interleaved raw chunks", async () => {
    const protocol = yamlXmlProtocol();
    const transformer = protocol.createStreamParser({ tools: basicTools });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "<get_wea" });
        ctrl.enqueue({
          type: "raw",
          rawValue: { choices: [{ delta: { content: "ther>\n" } }] },
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "ther>\nlocation: Berlin\n</get_weather>",
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });

    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const text = out
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("");
    const deltas = out
      .filter((part) => part.type === "tool-input-delta")
      .map((part) => part.delta)
      .join("");
    const tool = out.find((part) => part.type === "tool-call");

    expect(text).toBe("");
    expect(tool).toMatchObject({
      type: "tool-call",
      toolName: "get_weather",
    });
    if (tool?.type !== "tool-call") {
      throw new Error("Expected tool call");
    }
    expect(deltas).toBe(tool.input);
    expect(JSON.parse(tool.input)).toEqual({ location: "Berlin" });
  });

  it("should handle self-closing tag in stream", async () => {
    const protocol = yamlXmlProtocol();
    const transformer = protocol.createStreamParser({ tools: basicTools });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<get_location/>",
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });

    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const tool = out.find((c) => c.type === "tool-call") as {
      toolName: string;
      input: string;
    };
    expect(tool.toolName).toBe("get_location");
    expect(tool.input).toBe("{}");
  });

  it("should handle self-closing tag split across chunks", async () => {
    const protocol = yamlXmlProtocol();
    const transformer = protocol.createStreamParser({ tools: basicTools });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "<get_loca" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "tion/>" });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });

    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const tool = out.find((c) => c.type === "tool-call") as {
      toolName: string;
      input: string;
    };
    expect(tool.toolName).toBe("get_location");
    expect(tool.input).toBe("{}");
  });
});
