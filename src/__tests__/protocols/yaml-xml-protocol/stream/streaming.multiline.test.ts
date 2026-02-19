import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";
import { fileTools } from "../parse-generated-text/shared";

describe("yamlXmlProtocol streaming multiline YAML", () => {
  it("should handle multiline YAML values split across chunks", async () => {
    const protocol = yamlXmlProtocol();
    const transformer = protocol.createStreamParser({ tools: fileTools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<write_file>\n",
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "file_path: /tmp/test.txt\n",
        });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "contents: |\n" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "  Line one\n" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "  Line two\n" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "</write_file>" });
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
    expect(tool.toolName).toBe("write_file");
    const args = JSON.parse(tool.input);
    expect(args.file_path).toBe("/tmp/test.txt");
    expect(args.contents).toContain("Line one");
    expect(args.contents).toContain("Line two");
  });
});
