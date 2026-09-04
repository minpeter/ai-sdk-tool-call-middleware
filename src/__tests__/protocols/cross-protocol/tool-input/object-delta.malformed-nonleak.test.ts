import type {
  JSONSchema7,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import type {
  ProtocolError,
  ProtocolMetadata,
  TCMCoreProtocol,
} from "../../../../core/protocols/protocol-interface";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import {
  extractTextDeltas,
  extractToolInputDeltas,
  runProtocolTextDeltaStream,
} from "./streaming-events.shared";

const weatherTool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "get_weather",
  inputSchema: {
    type: "object",
    required: ["location"],
    properties: {
      unit: { type: "string" },
      location: { type: "string" },
    },
  },
};

const pollutedPropertySchema: JSONSchema7 = { type: "boolean" };
const constructorPropertySchema: JSONSchema7 = {
  type: "object",
  properties: {
    polluted: pollutedPropertySchema,
  },
};
const unsafeInputSchema: JSONSchema7 = {
  type: "object",
  properties: {
    constructor: constructorPropertySchema,
  },
};

const unsafeSchemaTool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "unsafe",
  description: "Unsafe schema fixture",
  inputSchema: unsafeInputSchema,
};

interface PrototypeSensitiveStreamCase {
  readonly name: string;
  readonly protocol: TCMCoreProtocol;
  readonly text: string;
}

const prototypeSensitiveStreamCases: readonly PrototypeSensitiveStreamCase[] = [
  {
    name: "Hermes",
    protocol: hermesProtocol(),
    text: '<tool_call>{"name":"get_weather","arguments":{"location":"Seoul","constructor":{"polluted":true}}}</tool_call>',
  },
  {
    name: "Morph XML",
    protocol: morphXmlProtocol(),
    text: "<get_weather><location>Seoul</location><constructor><polluted>true</polluted></constructor></get_weather>",
  },
  {
    name: "YAML XML",
    protocol: yamlXmlProtocol(),
    text: "<get_weather>\nlocation: Seoul\nconstructor:\n  polluted: true\n</get_weather>",
  },
  {
    name: "Qwen3Coder",
    protocol: qwen3CoderProtocol(),
    text: '<tool_call>\n  <function=get_weather>\n    <parameter=location>Seoul</parameter>\n    <parameter=constructor>{"polluted":true}</parameter>\n  </function>\n</tool_call>',
  },
];

type StreamOutput = Awaited<ReturnType<typeof runProtocolTextDeltaStream>>;

function expectNoToolCall(out: StreamOutput): void {
  expect(out.some((part) => part.type === "tool-call")).toBe(false);
}

function expectRejectedLifecycle(out: StreamOutput): void {
  expectNoToolCall(out);
  expect(out.some((part) => part.type === "tool-input-end")).toBe(true);
}

function expectAbsent(text: string, values: readonly string[]): void {
  for (const value of values) {
    expect(text).not.toContain(value);
  }
}

function runRawRejected(
  protocol: TCMCoreProtocol,
  chunks: readonly string[]
): Promise<StreamOutput> {
  return runProtocolTextDeltaStream({
    protocol,
    tools: [weatherTool],
    chunks: [...chunks],
    options: { emitRawToolCallTextOnError: true },
  });
}

async function expectSensitivePairRejected(
  sensitiveKey: string
): Promise<void> {
  const xmlErrors: string[] = [];
  const yamlErrors: string[] = [];
  const [xmlOut, yamlOut] = await Promise.all([
    runProtocolTextDeltaStream({
      protocol: morphXmlProtocol(),
      tools: [weatherTool],
      chunks: [
        `<get_weather><location>Seoul</location><${sensitiveKey}><polluted>true</polluted></${sensitiveKey}></get_weather>`,
      ],
      options: { onError: (message) => xmlErrors.push(message) },
    }),
    runProtocolTextDeltaStream({
      protocol: yamlXmlProtocol(),
      tools: [weatherTool],
      chunks: [
        `<get_weather>\nlocation: Seoul\n${sensitiveKey}:\n  polluted: true\n</get_weather>`,
      ],
      options: { onError: (message) => yamlErrors.push(message) },
    }),
  ]);
  expectRejectedLifecycle(xmlOut);
  expectRejectedLifecycle(yamlOut);
  expect(extractTextDeltas(xmlOut)).not.toContain(sensitiveKey);
  expect(extractTextDeltas(yamlOut)).not.toContain(sensitiveKey);
  expect(xmlErrors.length).toBeGreaterThan(0);
  expect(yamlErrors.length).toBeGreaterThan(0);
}

describe("XML/YAML malformed non-leak guarantees", () => {
  it("Morph XML redacts prototype-sensitive parse error metadata", () => {
    const metadata: Array<ProtocolMetadata | undefined> = [];
    const out = morphXmlProtocol().parseGeneratedText({
      text: "<unsafe><constructor><polluted>true</polluted></constructor></unsafe>",
      tools: [unsafeSchemaTool],
      options: {
        onError: (_message, value) => {
          metadata.push(value);
        },
      },
    });

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    const error: ProtocolError = metadata[0]?.error;
    let errorMessage: string | undefined;
    if (typeof error === "string") {
      errorMessage = error;
    } else if (error instanceof Error) {
      errorMessage = error.message;
    }
    const errorCause = error instanceof Error ? error.cause : undefined;
    let causeMessage: string | undefined;
    if (typeof errorCause === "string") {
      causeMessage = errorCause;
    } else if (errorCause instanceof Error) {
      causeMessage = errorCause.message;
    }
    const errorText = [errorMessage, causeMessage]
      .filter((message) => message !== undefined)
      .join("\n");
    expect(errorText).not.toContain("constructor");
    expect(errorText).not.toContain("polluted");
    expect(JSON.stringify(metadata[0]?.toolCall)).not.toContain("constructor");
  });

  it("malformed xml/yaml do not leave dangling tool-input streams", async () => {
    const [xmlOut, yamlOut] = await Promise.all([
      runProtocolTextDeltaStream({
        protocol: morphXmlProtocol(),
        tools: [weatherTool],
        chunks: ["<get_weather><location>Seoul<location></get_weather>"],
      }),
      runProtocolTextDeltaStream({
        protocol: yamlXmlProtocol(),
        tools: [weatherTool],
        chunks: ["<get_weather>\n- invalid\n- yaml\n</get_weather>"],
      }),
    ]);

    const xmlStarts = xmlOut.filter((part) => part.type === "tool-input-start");
    const xmlEnds = xmlOut.filter((part) => part.type === "tool-input-end");
    const yamlStarts = yamlOut.filter(
      (part) => part.type === "tool-input-start"
    );
    const yamlEnds = yamlOut.filter((part) => part.type === "tool-input-end");

    expect(xmlStarts.length).toBe(xmlEnds.length);
    expect(yamlStarts.length).toBe(yamlEnds.length);
    expect(xmlOut.some((part) => part.type === "finish")).toBe(true);
    expect(yamlOut.some((part) => part.type === "finish")).toBe(true);
  });

  it("prototype-sensitive stream args fail closed without throwing", async () => {
    await expectSensitivePairRejected("constructor");
  });

  it("__proto__ stream args fail closed without throwing", async () => {
    await expectSensitivePairRejected("__proto__");
  });

  it.each([
    {
      name: "Morph XML",
      protocol: morphXmlProtocol(),
      chunks: [
        "<get_weather><location>Seoul</location>",
        "<constructor><polluted>true</polluted></constructor></get_weather>",
      ],
    },
    {
      name: "YAML XML",
      protocol: yamlXmlProtocol(),
      chunks: [
        "<get_weather>\nlocation: Seoul\n",
        "constructor:\n  polluted: true\n</get_weather>",
      ],
    },
    {
      name: "Qwen3Coder",
      protocol: qwen3CoderProtocol(),
      chunks: [
        "<tool_call><function=get_weather><parameter=location>Seoul</parameter>",
        '<parameter=constructor>{"polluted":true}</parameter></function></tool_call>',
      ],
    },
  ])(
    "$name closes tool-input lifecycle when a late sensitive arg rejects",
    async ({ protocol, chunks }) => {
      const out = await runRawRejected(protocol, chunks);

      expectRejectedLifecycle(out);
      const textOut = extractTextDeltas(out);
      expectAbsent(textOut, ["constructor", "<get_weather>", "<tool_call>"]);
    }
  );

  it.each([
    {
      name: "YAML XML",
      protocol: yamlXmlProtocol(),
      chunks: [
        "<get_weather>\nlocation: first-chunk-scalar-secret\n",
        "constructor:\n  polluted: true\n</get_weather>",
      ],
    },
    {
      name: "Qwen3Coder",
      protocol: qwen3CoderProtocol(),
      chunks: [
        "<tool_call><function=get_weather><parameter=location>first-chunk-scalar-secret</parameter>",
        '<parameter=constructor>{"polluted":true}</parameter></function></tool_call>',
      ],
    },
  ])(
    "$name does not emit scalar progress before late sensitive rejection",
    async ({ protocol, chunks }) => {
      const out = await runRawRejected(protocol, chunks);

      expectRejectedLifecycle(out);
      const toolInputOut = extractToolInputDeltas(out).join("");
      expectAbsent(toolInputOut, [
        "first-chunk-scalar-secret",
        "constructor",
        "polluted",
      ]);
      expect(extractTextDeltas(out)).not.toContain("<tool_call>");
      expect(extractTextDeltas(out)).not.toContain("<get_weather>");
    }
  );

  it.each([
    {
      name: "Morph XML",
      protocol: morphXmlProtocol(),
      chunks: [
        "<get_weather><location>Seoul</location>",
        "<unit>&lt;prototype&gt;x&lt;/prototype&gt;</unit></get_weather>",
      ],
    },
    {
      name: "Qwen3Coder",
      protocol: qwen3CoderProtocol(),
      chunks: [
        "<tool_call><function=get_weather><parameter=location>Seoul</parameter>",
        "<parameter=unit>&lt;prototype&gt;x&lt;/prototype&gt;</parameter></function></tool_call>",
      ],
    },
  ])(
    "$name closes tool-input lifecycle when decoded args are sensitive",
    async ({ protocol, chunks }) => {
      const out = await runRawRejected(protocol, chunks);

      expectRejectedLifecycle(out);
      const textOut = extractTextDeltas(out);
      expect(textOut).not.toContain("prototype");
      expect(textOut).not.toContain("<get_weather>");
      expect(textOut).not.toContain("<tool_call>");
    }
  );

  it("Morph XML does not emit buffered progress deltas for split sensitive input", async () => {
    const out = await runRawRejected(morphXmlProtocol(), [
      '<get_weather><unit>{"secret":"abc", ',
      '"__proto__":{}}</unit></get_weather>',
    ]);

    expectRejectedLifecycle(out);
    const toolInputOut = extractToolInputDeltas(out).join("");
    expectAbsent(toolInputOut, ["secret", "__proto__"]);
    expect(extractTextDeltas(out)).not.toContain("<get_weather>");
  });

  it("Morph XML buffers JSON-unicode structured split sensitive input", async () => {
    const out = await runRawRejected(morphXmlProtocol(), [
      '<get_weather><unit>\\u007b"secret":"abc", ',
      '"__proto__":{}}</unit></get_weather>',
    ]);

    expectNoToolCall(out);
    const toolInputOut = extractToolInputDeltas(out).join("");
    expectAbsent(toolInputOut, ["secret", "__proto__"]);
    expect(extractTextDeltas(out)).not.toContain("<get_weather>");
  });

  it.each([
    {
      name: "YAML XML",
      protocol: yamlXmlProtocol(),
      chunks: [
        '<get_weather>\nlocation: Seoul\nunit: |\n  {"secret":"abc",\n',
        '  "__proto__":{}}\n</get_weather>',
      ],
    },
    {
      name: "Qwen3Coder",
      protocol: qwen3CoderProtocol(),
      chunks: [
        '<tool_call><function=get_weather><parameter=location>Seoul</parameter><parameter=unit>{"secret":"abc", ',
        '"__proto__":{}}</parameter></function></tool_call>',
      ],
    },
  ])(
    "$name does not emit progress deltas for split sensitive string input",
    async ({ protocol, chunks }) => {
      const out = await runRawRejected(protocol, chunks);

      expectNoToolCall(out);
      const toolInputOut = extractToolInputDeltas(out).join("");
      expectAbsent(toolInputOut, ["secret", "__proto__"]);
      expect(extractTextDeltas(out)).not.toContain("<tool_call>");
      expect(extractTextDeltas(out)).not.toContain("<get_weather>");
    }
  );

  it("Morph XML buffers YAML-shaped split sensitive string input", async () => {
    const out = await runRawRejected(morphXmlProtocol(), [
      "<get_weather><location>Seoul</location><unit>secret: abc\n",
      "constructor:\n  polluted: true</unit></get_weather>",
    ]);

    expectNoToolCall(out);
    const toolInputOut = extractToolInputDeltas(out).join("");
    expectAbsent(toolInputOut, ["secret", "constructor"]);
    expect(extractTextDeltas(out)).not.toContain("<get_weather>");
  });

  it.each([
    {
      name: "Morph XML",
      protocol: morphXmlProtocol(),
      chunks: [
        "<get_weather><location>Seoul</location><unit>constructor",
        ":\n  polluted: true</unit></get_weather>",
      ],
    },
    {
      name: "YAML XML",
      protocol: yamlXmlProtocol(),
      chunks: [
        "<get_weather>\nlocation: Seoul\nunit: |\n  constructor",
        ":\n    polluted: true\n</get_weather>",
      ],
    },
    {
      name: "Qwen3Coder",
      protocol: qwen3CoderProtocol(),
      chunks: [
        "<tool_call><function=get_weather><parameter=location>Seoul</parameter><parameter=unit>constructor",
        ":\n  polluted: true</parameter></function></tool_call>",
      ],
    },
  ])(
    "$name buffers pre-colon YAML-sensitive string input",
    async ({ protocol, chunks }) => {
      const out = await runRawRejected(protocol, chunks);

      expectNoToolCall(out);
      const toolInputOut = extractToolInputDeltas(out).join("");
      expectAbsent(toolInputOut, ["constructor", "polluted"]);
      expect(extractTextDeltas(out)).not.toContain("<tool_call>");
      expect(extractTextDeltas(out)).not.toContain("<get_weather>");
    }
  );

  it.each(prototypeSensitiveStreamCases)(
    "$name does not emit prototype-sensitive raw fallback when raw-on-error is enabled",
    async ({ protocol, text }) => {
      const out = await runRawRejected(protocol, [text]);

      expectNoToolCall(out);
      const textOut = extractTextDeltas(out);
      expect(textOut).not.toContain("constructor");
      expect(textOut).not.toContain("<tool_call>");
      expect(textOut).not.toContain("<get_weather>");
    }
  );

  it("Qwen3Coder does not emit unfinished prototype-sensitive raw fallback at finish", async () => {
    const out = await runRawRejected(qwen3CoderProtocol(), [
      '<tool_call>\n  <function=get_weather>\n    <parameter=location>Seoul</parameter>\n    <parameter=constructor>{"polluted":true}</parameter>',
    ]);

    expectNoToolCall(out);
    const textOut = extractTextDeltas(out);
    expect(textOut).not.toContain("constructor");
    expect(textOut).not.toContain("<tool_call>");
  });

  it("Hermes does not emit unfinished prototype-sensitive raw fallback at finish", async () => {
    const out = await runRawRejected(hermesProtocol(), [
      '<tool_call>{"name":"get_weather","arguments":{"location":"Seoul","constructor":{"polluted":true}}}',
    ]);

    expectNoToolCall(out);
    const textOut = extractTextDeltas(out);
    expect(textOut).not.toContain("constructor");
    expect(textOut).not.toContain("<tool_call>");
  });

  it("Hermes does not emit nested-start prototype-sensitive raw fallback", async () => {
    const out = await runRawRejected(hermesProtocol(), [
      '<tool_call>{"name":"get_weather","arguments":{"location":"Seoul","constructor":{"polluted":true}}}<tool_call>',
    ]);

    expectNoToolCall(out);
    const textOut = extractTextDeltas(out);
    expect(textOut).not.toContain("constructor");
  });
});
