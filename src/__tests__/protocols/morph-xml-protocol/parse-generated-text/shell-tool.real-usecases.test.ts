import { describe, expect, it, vi } from "vitest";

import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";

vi.spyOn(console, "warn").mockImplementation(() => {
  // suppress noisy console output during test
});

describe("morphXmlProtocol - shell tool", () => {
  const tools = [
    {
      type: "function",
      name: "shell",
      description: "Runs a shell command and returns its output.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "array",
            items: { type: "string" },
            description: "The command to execute",
          },
          justification: {
            type: "string",
            description:
              "Only set if with_escalated_permissions is true. 1-sentence explanation of why we want to run this command.",
          },
          timeout_ms: {
            type: "number",
            description: "The timeout for the command in milliseconds",
          },
          with_escalated_permissions: {
            type: "boolean",
            description:
              "Whether to request escalated permissions. Set to true if command needs to be run without sandbox restrictions",
          },
          workdir: {
            type: "string",
            description: "The working directory to execute the command in",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  ] as any;

  it("[malformed closing tag handling] parses shell call with extra stray </command> and produces correct arguments", () => {
    const p = morphXmlProtocol();

    const text =
      "<shell>" +
      "<command>ls</command>" +
      "<command>app</command>" +
      "<command>components</command>" +
      "<command>shared</command>" +
      "</command>" +
      "<justification>List contents of key source\n  directories</justification>" +
      "<timeout_ms>5000</timeout_ms>" +
      "<with_escalated_permissions>false</with_escalated_permissions>" +
      "<workdir>/Users/minpeter/github.com/minpeter/\n  minpeter.v2</workdir>" +
      "</shell>";

    const out = p.parseGeneratedText({ text, tools, options: {} });

    const tc = out.find((part) => (part as any).type === "tool-call") as any;
    expect(tc).toBeTruthy();
    expect(tc.toolName).toBe("shell");

    const input = JSON.parse(tc.input);

    expect(input.command).toEqual(["ls", "app", "components", "shared"]);
    expect(input.justification).toBe(
      "List contents of key source\n  directories"
    );
    expect(input.timeout_ms).toBe(5000);
    expect(input.with_escalated_permissions).toBe(false);

    expect(typeof input.workdir).toBe("string");
    expect(input.workdir.includes("/Users/minpeter/github.com/minpeter/")).toBe(
      true
    );
    expect(input.workdir.includes("minpeter.v2")).toBe(true);
  });

  it("[excessive tag call] case where justification tag appears excessively", () => {
    const p = morphXmlProtocol();

    const text =
      "<shell><command>git</command><command>log</command><justification>oneline</justification><command>-10</" +
      "command><justification>Examine recent commit history for commit message patterns</justification><timeout_ms>5000</" +
      "timeout_ms><with_escalated_permissions>false</with_escalated_permissions><workdir>.</workdir></shell>";

    const out = p.parseGeneratedText({ text, tools, options: {} });

    const tc = out.find((part) => (part as any).type === "tool-call") as any;
    expect(tc).toBeTruthy();
    expect(tc.toolName).toBe("shell");

    const input = JSON.parse(tc.input);

    expect(input.command).toEqual(["git", "log", "-10"]);
    expect(input.justification).toBe(
      "Examine recent commit history for commit message patterns"
    );
    expect(input.timeout_ms).toBe(5000);
    expect(input.with_escalated_permissions).toBe(false);
    expect(input.workdir).toBe(".");
  });

  it("[Special character handling] Handling of special characters such as '>', '<<'", () => {
    const p = morphXmlProtocol();

    const text =
      "<shell><command>cat > test.md << 'EOF'" +
      "# Test File\n\n" +
      "This is a test markdown file.\n" +
      "EOF</command></shell>";

    const out = p.parseGeneratedText({ text, tools, options: {} });

    const tc = out.find((part) => (part as any).type === "tool-call") as any;
    expect(tc).toBeTruthy();
    expect(tc.toolName).toBe("shell");
  });
});
