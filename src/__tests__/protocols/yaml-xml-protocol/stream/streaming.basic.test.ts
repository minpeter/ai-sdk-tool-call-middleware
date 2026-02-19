import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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

  it("should handle self-closing tag in stream", async () => {
    const protocol = yamlXmlProtocol();
    const transformer = protocol.createStreamParser({ tools: basicTools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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
