import { describe, expect, it } from "vitest";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import {
  parseToolCallObject,
  requireToolCall,
  runProtocolTextStream,
} from "../../shared/duplicate-harness";
import { fileTools } from "../parse-generated-text/shared";

describe("yamlXmlProtocol streaming multiline YAML", () => {
  it("should handle multiline YAML values split across chunks", async () => {
    const out = await runProtocolTextStream({
      protocol: yamlXmlProtocol(),
      tools: fileTools,
      id: "1",
      chunks: [
        "<write_file>\n",
        "file_path: /tmp/test.txt\n",
        "contents: |\n",
        "  Line one\n",
        "  Line two\n",
        "</write_file>",
      ],
    });
    const toolCall = requireToolCall(out);
    expect(toolCall.toolName).toBe("write_file");
    const input = parseToolCallObject(toolCall);
    expect(input.file_path).toBe("/tmp/test.txt");
    expect(input.contents).toContain("Line one");
    expect(input.contents).toContain("Line two");
  });
});
