import type {
  JSONValue,
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";

// Intentionally accepts malformed schemas so tests can exercise runtime rejection.
function makeSchemaTool(
  name: string,
  inputSchema: JSONValue
): LanguageModelV4FunctionTool {
  return {
    type: "function",
    name,
    inputSchema: inputSchema as LanguageModelV4FunctionTool["inputSchema"],
  };
}

type ToolCallContent = Extract<LanguageModelV4Content, { type: "tool-call" }>;

function expectToolCall(output: LanguageModelV4Content[]): ToolCallContent {
  const tool = output.find(
    (part): part is ToolCallContent => part.type === "tool-call"
  );
  expect(tool?.type).toBe("tool-call");
  if (!tool) {
    throw new Error("Expected tool call");
  }
  return tool;
}

describe("json-repair.test split 5", () => {
  it("drops nested argument keys disallowed by false schemas", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"payload":{"value":"ok","secret":"blocked"}}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          payload: {
            type: "object",
            properties: {
              secret: false,
              value: { type: "string" },
            },
            additionalProperties: true,
          },
        },
        required: ["payload"],
        additionalProperties: false,
      }),
    ];
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const tool = out.find((x) => x.type === "tool-call");
    expect(tool?.type).toBe("tool-call");
    expect(tool?.type === "tool-call" ? JSON.parse(tool.input) : null).toEqual({
      payload: { value: "ok" },
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("rejects top-level boolean false input schemas", () => {
    const p = hermesProtocol();
    const schemas: JSONValue[] = [false, { jsonSchema: false }];
    for (const inputSchema of schemas) {
      const onError = vi.fn();
      const text =
        '<tool_call>{"name":"deny","arguments":{"content":"ok"}}</tool_call>';
      const out = p.parseGeneratedText({
        text,
        tools: [makeSchemaTool("deny", inputSchema)],
        options: { onError },
      });
      expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
      expect(onError).toHaveBeenCalled();
    }
  });

  it("rejects non-object arguments for top-level boolean false input schemas", () => {
    const p = hermesProtocol();
    const schemas: JSONValue[] = [false, { jsonSchema: false }];
    const argumentBodies = ["[]", "null", '"x"'];

    for (const inputSchema of schemas) {
      for (const argumentBody of argumentBodies) {
        const onError = vi.fn();
        const text = `<tool_call>{"name":"deny","arguments":${argumentBody}}</tool_call>`;
        const out = p.parseGeneratedText({
          text,
          tools: [makeSchemaTool("deny", inputSchema)],
          options: { onError },
        });
        expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
        expect(onError).toHaveBeenCalled();
      }
    }
  });

  it("rejects non-object arguments for object input schemas", () => {
    const p = hermesProtocol();
    const argumentBodies = ["[]", "null", '"x"'];
    const schemas: JSONValue[] = [
      {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        required: ["content"],
      },
      {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        required: ["content"],
        additionalProperties: false,
      },
    ];
    for (const inputSchema of schemas) {
      for (const argumentBody of argumentBodies) {
        const onError = vi.fn();
        const text = `<tool_call>{"name":"write","arguments":${argumentBody}}</tool_call>`;
        const out = p.parseGeneratedText({
          text,
          tools: [makeSchemaTool("write", inputSchema)],
          options: { onError },
        });
        expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
        expect(onError).toHaveBeenCalled();
      }
    }
  });

  it("accepts omitted arguments for no-input tool calls", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text = '<tool_call>{"name":"ping"}</tool_call>';
    const out = p.parseGeneratedText({
      text,
      tools: [
        makeSchemaTool("ping", {
          type: "object",
          properties: {},
          additionalProperties: false,
        }),
      ],
      options: { onError },
    });
    const tool = expectToolCall(out);
    expect(tool.input).toBe("{}");
    expect(onError).not.toHaveBeenCalled();
  });

  it("accepts null arguments when the top-level schema allows null", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text = '<tool_call>{"name":"write","arguments":null}</tool_call>';
    const out = p.parseGeneratedText({
      text,
      tools: [
        makeSchemaTool("write", {
          type: ["object", "null"],
          properties: {
            content: { type: "string" },
          },
          additionalProperties: false,
        }),
      ],
      options: { onError },
    });
    const tool = expectToolCall(out);
    expect(tool.input).toBe("null");
    expect(onError).not.toHaveBeenCalled();
  });

  it("rejects null arguments without a matching nullable schema", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text = '<tool_call>{"name":"write","arguments":null}</tool_call>';
    const out = p.parseGeneratedText({
      text,
      tools: [makeSchemaTool("write", { type: "object" })],
      options: { onError },
    });
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(out).toContainEqual({ type: "text", text });
    expect(onError).toHaveBeenCalled();
  });

  it("drops args for schemas without declared properties when additionalProperties is false", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"x-":"ok"}}</tool_call>';
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        additionalProperties: false,
      }),
    ];

    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const tool = expectToolCall(out);
    expect(JSON.parse(tool.input)).toEqual({});
    expect(onError).not.toHaveBeenCalled();
  });

  it("rejects null for non-nullable typed object properties", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"content":null}}</tool_call>';
    const out = p.parseGeneratedText({
      text,
      tools: [
        makeSchemaTool("write", {
          type: "object",
          properties: {
            content: { type: "string" },
          },
          required: ["content"],
          additionalProperties: false,
        }),
      ],
      options: { onError },
    });
    expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("accepts null for nullable object and array properties", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"write","arguments":{"payload":null,"rows":null}}</tool_call>';
    const out = p.parseGeneratedText({
      text,
      tools: [
        makeSchemaTool("write", {
          type: "object",
          properties: {
            payload: {
              type: ["object", "null"],
              properties: { content: { type: "string" } },
              required: ["content"],
              additionalProperties: false,
            },
            rows: {
              type: ["array", "null"],
              items: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
            },
          },
          required: ["payload", "rows"],
          additionalProperties: false,
        }),
      ],
      options: { onError },
    });
    const tool = out.find((x) => x.type === "tool-call");
    expect(tool?.type).toBe("tool-call");
    expect(tool?.type === "tool-call" ? JSON.parse(tool.input) : null).toEqual({
      payload: null,
      rows: null,
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("rejects non-object arguments for allOf-wrapped strict object input schemas", () => {
    const p = hermesProtocol();
    const argumentBodies = ["[]", '"scalar"'];
    for (const argumentBody of argumentBodies) {
      const onError = vi.fn();
      const text = `<tool_call>{"name":"write","arguments":${argumentBody}}</tool_call>`;
      const out = p.parseGeneratedText({
        text,
        tools: [
          makeSchemaTool("write", {
            allOf: [
              {
                type: "object",
                properties: {
                  content: { type: "string" },
                },
                required: ["content"],
                additionalProperties: false,
              },
            ],
          }),
        ],
        options: { onError },
      });
      expect(out.find((x) => x.type === "tool-call")).toBeUndefined();
      expect(onError).toHaveBeenCalled();
    }
  });

  it("coerces keys before validating allOf-wrapped strict object schemas", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"translate","arguments":{"target_language":"ko"}}</tool_call>';
    const out = p.parseGeneratedText({
      text,
      tools: [
        makeSchemaTool("translate", {
          allOf: [
            {
              type: "object",
              properties: {
                targetLanguage: { type: "string" },
              },
              required: ["targetLanguage"],
              additionalProperties: false,
            },
          ],
        }),
      ],
      options: { onError },
    });
    const tool = out.find((x) => x.type === "tool-call");
    expect(tool?.type).toBe("tool-call");
    expect(tool?.type === "tool-call" ? JSON.parse(tool.input) : null).toEqual({
      targetLanguage: "ko",
    });
    expect(onError).not.toHaveBeenCalled();
  });
});
