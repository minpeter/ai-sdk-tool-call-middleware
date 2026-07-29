import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { glm5Protocol } from "../../../core/protocols/glm5-protocol";
import { glm5Tools, normalizeContentToolCalls, toolCallInput } from "./shared";

const typedCall = [
  "<tool_call>typed_action",
  "<arg_key>text</arg_key><arg_value>hello</arg_value>",
  "<arg_key>truthy_text</arg_key><arg_value>true</arg_value>",
  "<arg_key>nullable_text</arg_key><arg_value>null</arg_value>",
  "<arg_key>count</arg_key><arg_value>42</arg_value>",
  "<arg_key>enabled</arg_key><arg_value>true</arg_value>",
  "<arg_key>ratio</arg_key><arg_value>1.25</arg_value>",
  '<arg_key>tags</arg_key><arg_value>["alpha","beta"]</arg_value>',
  '<arg_key>config</arg_key><arg_value>{"mode":"safe","enabled":false}</arg_value>',
  "</tool_call>",
].join("");

const aceBareCallTool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "corporate_innovation_culture",
  description: "Assess corporate innovation culture.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      industry: { type: "string" },
      total_employees: { type: "integer" },
    },
    required: ["industry", "total_employees"],
  },
};

describe("glm5Protocol parseGeneratedText canonical grammar", () => {
  it("parses the official zero-argument call form", () => {
    const output = glm5Protocol().parseGeneratedText({
      text: "<tool_call>ping</tool_call>",
      tools: glm5Tools,
    });

    expect(normalizeContentToolCalls(output)).toEqual([
      { toolName: "ping", input: {} },
    ]);
  });

  it("coerces non-string JSON values while preserving schema strings that look like literals", () => {
    const output = glm5Protocol().parseGeneratedText({
      text: typedCall,
      tools: glm5Tools,
    });

    expect(normalizeContentToolCalls(output)).toEqual([
      {
        toolName: "typed_action",
        input: {
          text: "hello",
          truthy_text: "true",
          nullable_text: "null",
          count: 42,
          enabled: true,
          ratio: 1.25,
          tags: ["alpha", "beta"],
          config: { mode: "safe", enabled: false },
        },
      },
    ]);
  });

  it("parses directly concatenated calls and preserves text before, between, and after calls", () => {
    const first =
      "<tool_call>get-weather<arg_key>city</arg_key><arg_value>서울</arg_value></tool_call>";
    const second = "<tool_call>ping</tool_call>";
    const output = glm5Protocol().parseGeneratedText({
      text: `before ${first} between ${second} after`,
      tools: glm5Tools,
    });

    expect(output.map((part) => part.type)).toEqual([
      "text",
      "tool-call",
      "text",
      "tool-call",
      "text",
    ]);
    expect(output.filter((part) => part.type === "text")).toEqual([
      { type: "text", text: "before " },
      { type: "text", text: " between " },
      { type: "text", text: " after" },
    ]);
    expect(normalizeContentToolCalls(output)).toEqual([
      { toolName: "get-weather", input: { city: "서울" } },
      { toolName: "ping", input: {} },
    ]);

    const adjacent = glm5Protocol().parseGeneratedText({
      text: `${first}${second}`,
      tools: glm5Tools,
    });
    expect(adjacent.map((part) => part.type)).toEqual([
      "tool-call",
      "tool-call",
    ]);
  });
});

describe("glm5Protocol anchored bare-call fallback", () => {
  const tools = [...glm5Tools, aceBareCallTool];

  it("recovers the anchored ACE bare call after canonical parsing finds no call", () => {
    const text =
      'corporate_innovation_culture(industry="金融科技", total_employees=500)';
    const protocol = glm5Protocol();
    const output = protocol.parseGeneratedText({ text, tools });

    expect(output.map((part) => part.type)).toEqual(["tool-call"]);
    expect(normalizeContentToolCalls(output)).toEqual([
      {
        toolName: "corporate_innovation_culture",
        input: { industry: "金融科技", total_employees: 500 },
      },
    ]);
    expect(protocol.extractToolCallSegments?.({ text, tools })).toEqual([text]);
  });

  it("keeps canonical calls authoritative when bare-call-like text is also present", () => {
    const bareCall =
      'corporate_innovation_culture(industry="金融科技", total_employees=500)';
    const canonicalCall = "<tool_call>ping</tool_call>";
    const output = glm5Protocol().parseGeneratedText({
      text: `${bareCall}\n${canonicalCall}`,
      tools,
    });

    expect(normalizeContentToolCalls(output)).toEqual([
      { toolName: "ping", input: {} },
    ]);
    expect(output.filter((part) => part.type === "text")).toEqual([
      { type: "text", text: `${bareCall}\n` },
    ]);
  });

  it.each([
    'I will call corporate_innovation_culture(industry="金融科技", total_employees=500)',
    '```corporate_innovation_culture(industry="金融科技", total_employees=500)```',
    'unknown(industry="金融科技", total_employees=500)',
    'corporate_innovation_culture(industry="金融科技", unknown=500)',
    'corporate_innovation_culture(industry="金融科技", industry="银行", total_employees=500)',
    'corporate_innovation_culture(__proto__={"polluted":true}, total_employees=500)',
    'corporate_innovation_culture(industry="金融科技", total_employees=500',
  ])("does not turn unsafe or unanchored text into a tool call: %s", (text) => {
    const protocol = glm5Protocol();

    expect(protocol.parseGeneratedText({ text, tools })).toEqual([
      { type: "text", text },
    ]);
    expect(protocol.extractToolCallSegments?.({ text, tools })).toEqual([]);
    expect(
      (Object.prototype as Record<string, unknown>).polluted
    ).toBeUndefined();
  });
});

describe("glm5Protocol string whitespace handling", () => {
  it("removes newline layout indentation but preserves intentional inline spaces", () => {
    const output = glm5Protocol().parseGeneratedText({
      text: [
        "<tool_call>echo",
        "<arg_key>message</arg_key>",
        "<arg_value>\n    hello  world \n  </arg_value>",
        "</tool_call>",
      ].join(""),
      tools: glm5Tools,
    });

    expect(toolCallInput(output)).toEqual({ message: "hello  world " });
  });

  it("can preserve every boundary character when explicitly configured", () => {
    const output = glm5Protocol({
      stringBoundaryNormalization: "preserve",
    }).parseGeneratedText({
      text: [
        "<tool_call>echo",
        "<arg_key>message</arg_key>",
        "<arg_value>\n  exact \n</arg_value>",
        "</tool_call>",
      ].join(""),
      tools: glm5Tools,
    });

    expect(toolCallInput(output)).toEqual({ message: "\n  exact \n" });
  });
});

describe("glm5Protocol conservative recovery", () => {
  it("recovers a unique generated-name digest or its exact digestless stem", () => {
    const tools: LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "OfficeSoftware_Conferencing_deleteMeetingRecord_921076aae716",
        inputSchema: {
          type: "object",
          properties: { meeting_id: { type: "string" } },
          required: ["meeting_id"],
        },
      },
      {
        type: "function",
        name: "NewsMagazines_News_getLiveNews_d13bf6d5d7cc",
        inputSchema: {
          type: "object",
          properties: { channel: { type: "string" } },
          required: ["channel"],
        },
      },
      {
        type: "function",
        name: "OnlineShopping_searchExpress_a9bee1c127af",
        inputSchema: {
          type: "object",
          properties: { express_id: { type: "string" } },
          required: ["express_id"],
        },
      },
    ];
    const onError = vi.fn();
    const output = glm5Protocol().parseGeneratedText({
      text: [
        "<tool_call>OfficeSoftware_Conferencing_deleteMeeting_921076aae716",
        "<arg_key>meeting_id</arg_key><arg_value>M123</arg_value>",
        "</tool_call>",
        "<tool_call>NewsMagazines_News_getLiveNews",
        "<arg_key>channel</arg_key><arg_value>sports</arg_value>",
        "</tool_call>",
        "<tool_call>OnlineShopping_searchExpress_a9bee1c127afaf",
        "<arg_key>express_id</arg_key><arg_value>123</arg_value>",
        "</tool_call>",
      ].join(""),
      tools,
      options: { onError },
    });

    expect(normalizeContentToolCalls(output)).toEqual([
      {
        toolName:
          "OfficeSoftware_Conferencing_deleteMeetingRecord_921076aae716",
        input: { meeting_id: "M123" },
      },
      {
        toolName: "NewsMagazines_News_getLiveNews_d13bf6d5d7cc",
        input: { channel: "sports" },
      },
      {
        toolName: "OnlineShopping_searchExpress_a9bee1c127af",
        input: { express_id: "123" },
      },
    ]);
    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledWith(
      "Recovered malformed GLM-5.2 tool call.",
      expect.objectContaining({
        recoveryCodes: expect.arrayContaining(["recovered-tool-name"]),
      })
    );
  });

  it("recovers one stray arg-value close only for a zero-argument mapped tool", () => {
    const tools: LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "NewsMagazines_viewCollection_932c48ae403c",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
          required: [],
        },
      },
    ];
    const onError = vi.fn();
    const output = glm5Protocol().parseGeneratedText({
      text: "<tool_call>NewsMagazines_viewCollect_932c48ae403c</arg_value></tool_call>",
      tools,
      options: { onError },
    });

    expect(normalizeContentToolCalls(output)).toEqual([
      {
        toolName: "NewsMagazines_viewCollection_932c48ae403c",
        input: {},
      },
    ]);
    expect(onError).toHaveBeenCalledWith(
      "Recovered malformed GLM-5.2 tool call.",
      expect.objectContaining({
        recoveryCodes: expect.arrayContaining([
          "recovered-tool-name",
          "recovered-stray-empty-arg-value-close",
        ]),
      })
    );
  });

  it("recovers live generated-digest corruption only for one exact stem", () => {
    const names = [
      "Finance_Banking_modifyFinancialProductOrder_debaf3226b6b",
      "Photography_VideoRecording_macroVideo_9f98a7a49930",
      "UtilityTools_AIGC_aigcPicture2Pictrue_5d19523c7c77",
      "Navigation_FlightTickets_cancelFlightBooking_b76e4e1b22f4",
      "Health_HealthManagement_searchDietRecord_ce88900433a9",
    ];
    const tools: LanguageModelV4FunctionTool[] = names.map((name) => ({
      type: "function",
      name,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    }));
    const returnedNames = [
      "Finance_Banking_modifyFinancialProductOrder_debafaf3226b6b",
      "Photography_VideoRecording_macroVideo_9f98a49930",
      "UtilityTools_AIGC_aigcPicture2Pictrue_5d19523c",
      "Navigation_FlightTickets_cancelFlightBooking_b76e4e3b22f4",
      "Health_HealthManagement_searchDietRecord_ce88900433a00433a9",
    ];
    const onError = vi.fn();
    const output = glm5Protocol().parseGeneratedText({
      text: returnedNames
        .map(
          (name, index) =>
            `<tool_call>${name}<arg_key>id</arg_key><arg_value>${index}</arg_value></tool_call>`
        )
        .join(""),
      tools,
      options: { onError },
    });

    expect(normalizeContentToolCalls(output)).toEqual(
      names.map((toolName, index) => ({
        toolName,
        input: { id: String(index) },
      }))
    );
    expect(onError).toHaveBeenCalledTimes(names.length);
  });

  it("rejects ambiguous generated-name digest and stem recovery", () => {
    const tools: LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "first_aaaaaaaaaaaa",
        inputSchema: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "second_aaaaaaaaaaaa",
        inputSchema: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "shared_bbbbbbbbbbbb",
        inputSchema: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "shared_cccccccccccc",
        inputSchema: { type: "object", properties: {} },
      },
    ];

    expect(
      normalizeContentToolCalls(
        glm5Protocol().parseGeneratedText({
          text: [
            "<tool_call>unknown_aaaaaaaaaaaa</tool_call>",
            "<tool_call>shared</tool_call>",
            "<tool_call>shared_dddddddd</tool_call>",
          ].join(""),
          tools,
        })
      )
    ).toEqual([]);
  });

  it("recovers unique case and punctuation variants plus missing structural closes", () => {
    const onError = vi.fn();
    const output = glm5Protocol().parseGeneratedText({
      text: [
        "<tool_call>GET_WEATHER",
        "<arg_key>USER_ID",
        "<arg_value>account-7</arg_value>",
      ].join(""),
      tools: glm5Tools,
      options: { onError },
    });

    expect(normalizeContentToolCalls(output)).toEqual([
      {
        toolName: "get-weather",
        input: { "user-id": "account-7" },
      },
    ]);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      "Recovered malformed GLM-5.2 tool call.",
      expect.objectContaining({
        toolName: "get-weather",
        recoveryCodes: expect.arrayContaining([
          "recovered-tool-name",
          "recovered-argument-key",
          "recovered-missing-arg-key-close",
          "recovered-missing-tool-call-close",
        ]),
      })
    );
  });

  it("recovers a final value and call whose close tags were truncated", () => {
    const onError = vi.fn();
    const output = glm5Protocol().parseGeneratedText({
      text: "<tool_call>echo<arg_key>message</arg_key><arg_value>still useful",
      tools: glm5Tools,
      options: { onError },
    });

    expect(toolCallInput(output)).toEqual({ message: "still useful" });
    expect(onError).toHaveBeenCalledWith(
      "Recovered malformed GLM-5.2 tool call.",
      expect.objectContaining({
        recoveryCodes: expect.arrayContaining([
          "recovered-missing-arg-value-close",
          "recovered-missing-tool-call-close",
        ]),
      })
    );
  });

  it("preserves bounded bare references for explicitly open object handles", () => {
    const tools: LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "validate_payload",
        inputSchema: {
          type: "object",
          properties: {
            payload: { type: "object", additionalProperties: true },
            size: { type: "integer" },
          },
          required: ["payload", "size"],
        },
      },
    ];
    const onError = vi.fn();
    const text = [
      "<tool_call>validate_payload",
      "<arg_key>payload</arg_key><arg_value>responseData</arg_value>",
      "<arg_key>size</arg_key><arg_value>5</arg_value>",
      "</tool_call>",
    ].join("");

    expect(
      toolCallInput(
        glm5Protocol().parseGeneratedText({
          text,
          tools,
          options: { onError },
        })
      )
    ).toEqual({ payload: "responseData", size: 5 });
    expect(onError).toHaveBeenCalledWith(
      "Recovered malformed GLM-5.2 tool call.",
      expect.objectContaining({
        recoveryCodes: expect.arrayContaining([
          "recovered-opaque-object-reference",
        ]),
      })
    );
    expect(
      normalizeContentToolCalls(
        glm5Protocol({
          recoverOpaqueObjectReferences: false,
        }).parseGeneratedText({ text, tools })
      )
    ).toEqual([]);
  });

  it.each([
    "responseData + injected",
    "responseData(arg)",
    "responseData;pollute()",
    "constructor.prototype",
    "__proto__",
  ])("rejects an unsafe opaque object expression: %s", (reference) => {
    const tools: LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "consume",
        inputSchema: {
          type: "object",
          properties: {
            payload: { type: "object", additionalProperties: true },
          },
          required: ["payload"],
        },
      },
    ];
    const text = `<tool_call>consume<arg_key>payload</arg_key><arg_value>${reference}</arg_value></tool_call>`;

    expect(
      normalizeContentToolCalls(
        glm5Protocol().parseGeneratedText({ text, tools })
      )
    ).toEqual([]);
  });

  it("drops unknown arguments without inventing a schema mapping", () => {
    const onError = vi.fn();
    const output = glm5Protocol().parseGeneratedText({
      text: [
        "<tool_call>get-weather",
        "<arg_key>city</arg_key><arg_value>Busan</arg_value>",
        "<arg_key>unrelated</arg_key><arg_value>ignore me</arg_value>",
        "</tool_call>",
      ].join(""),
      tools: glm5Tools,
      options: { onError },
    });

    expect(toolCallInput(output)).toEqual({ city: "Busan" });
    expect(onError).toHaveBeenCalledWith(
      "Recovered malformed GLM-5.2 tool call.",
      expect.objectContaining({
        recoveryCodes: expect.arrayContaining(["dropped-unknown-argument-key"]),
      })
    );
  });

  it("does not guess when punctuation-normalized tool names are ambiguous", () => {
    const onError = vi.fn();
    const ambiguousTools = glm5Tools.concat([
      {
        type: "function",
        name: "get_weather",
        description: "Ambiguous on purpose.",
        inputSchema: { type: "object" },
      },
    ]);
    const output = glm5Protocol().parseGeneratedText({
      text: "<tool_call>GetWeather</tool_call>",
      tools: ambiguousTools,
      options: { onError },
    });

    expect(normalizeContentToolCalls(output)).toEqual([]);
    expect(onError).toHaveBeenCalledWith(
      "Could not parse GLM-5.2 tool call.",
      expect.objectContaining({ dropReason: "malformed-glm5-tool-call" })
    );
  });
});

describe("glm5Protocol argument safety", () => {
  it("keeps a canonical-looking call inside Markdown code as non-executable text", () => {
    const text = "Example only, do not execute: `<tool_call>ping</tool_call>`.";
    const protocol = glm5Protocol();

    const output = protocol.parseGeneratedText({ text, tools: glm5Tools });
    expect(normalizeContentToolCalls(output)).toEqual([]);
    expect(
      output
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    ).toBe(text);
    expect(
      protocol.extractToolCallSegments?.({ text, tools: glm5Tools })
    ).toEqual([]);
  });

  it("executes calls after a balanced Markdown code span even when the closing backtick is adjacent", () => {
    const text = "Use `CellResult`<tool_call>ping</tool_call>";
    const output = glm5Protocol().parseGeneratedText({
      text,
      tools: glm5Tools,
    });

    expect(normalizeContentToolCalls(output)).toEqual([
      { toolName: "ping", input: {} },
    ]);
    expect(
      output
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    ).toBe("Use `CellResult`");
  });

  it("does not let an unbalanced prose backtick swallow a later canonical call", () => {
    const text =
      "Repository `https://example.test/repo%60 from `/home/user` right away.<tool_call>ping</tool_call>";
    const output = glm5Protocol().parseGeneratedText({
      text,
      tools: glm5Tools,
    });

    expect(normalizeContentToolCalls(output)).toEqual([
      { toolName: "ping", input: {} },
    ]);
  });

  it("rejects a nested complete call that names a declared tool", () => {
    const text =
      "<tool_call>echo<arg_key>message</arg_key><arg_value>outer <tool_call>ping</tool_call></arg_value></tool_call>";
    const protocol = glm5Protocol();

    expect(
      normalizeContentToolCalls(
        protocol.parseGeneratedText({ text, tools: glm5Tools })
      )
    ).toEqual([]);
    expect(
      protocol.extractToolCallSegments?.({ text, tools: glm5Tools })
    ).toEqual([]);
  });

  it("rejects a duplicate argument instead of selecting either value", () => {
    const onError = vi.fn();
    const output = glm5Protocol().parseGeneratedText({
      text: [
        "<tool_call>echo",
        "<arg_key>message</arg_key><arg_value>first</arg_value>",
        "<arg_key>message</arg_key><arg_value>second</arg_value>",
        "</tool_call>",
      ].join(""),
      tools: glm5Tools,
      options: { onError },
    });

    expect(normalizeContentToolCalls(output)).toEqual([]);
    expect(onError).toHaveBeenCalledWith(
      "Could not parse GLM-5.2 tool call.",
      expect.objectContaining({
        dropReason: "malformed-glm5-tool-call",
      })
    );
  });

  it.each(["__proto__", "prototype", "constructor"])(
    "rejects the entire call containing prototype-sensitive key %s",
    (key) => {
      const onError = vi.fn();
      const output = glm5Protocol().parseGeneratedText({
        text: `<tool_call>open_action<arg_key>${key}</arg_key><arg_value>unsafe</arg_value></tool_call>`,
        tools: glm5Tools,
        options: { onError },
      });

      expect(normalizeContentToolCalls(output)).toEqual([]);
      expect(onError).toHaveBeenCalledWith(
        "Could not parse GLM-5.2 tool call.",
        expect.objectContaining({
          dropReason: "malformed-glm5-tool-call",
        })
      );
      expect(Object.prototype).not.toHaveProperty("polluted");
    }
  );

  it.each([
    "__proto__",
    '"__proto__"',
    "\\u005f\\u005fproto\\u005f\\u005f",
    "&#95;&#95;proto&#95;&#95;",
  ])(
    "rejects closed-schema prototype-sensitive key spelling %s instead of dropping it as unknown",
    (key) => {
      const onError = vi.fn();
      const text = `<tool_call>echo<arg_key>${key}</arg_key><arg_value>{}</arg_value></tool_call>`;
      const protocol = glm5Protocol();
      const output = protocol.parseGeneratedText({
        text,
        tools: glm5Tools,
        options: { onError },
      });

      expect(normalizeContentToolCalls(output)).toEqual([]);
      expect(
        protocol.extractToolCallSegments?.({ text, tools: glm5Tools })
      ).toEqual([]);
      expect(onError).toHaveBeenCalledWith(
        "Could not parse GLM-5.2 tool call.",
        expect.objectContaining({
          dropReason: "malformed-glm5-tool-call",
        })
      );
      expect(Object.prototype).not.toHaveProperty("polluted");
    }
  );

  it("rejects a call whose structured value contains a prototype-sensitive key", () => {
    const onError = vi.fn();
    const output = glm5Protocol().parseGeneratedText({
      text: [
        "<tool_call>typed_action",
        "<arg_key>config</arg_key>",
        '<arg_value>{"__proto__":{"polluted":true}}</arg_value>',
        "</tool_call>",
      ].join(""),
      tools: glm5Tools,
      options: { onError },
    });

    expect(normalizeContentToolCalls(output)).toEqual([]);
    expect(onError).toHaveBeenCalledWith(
      "Could not parse GLM-5.2 tool call.",
      expect.objectContaining({
        dropReason: "malformed-glm5-tool-call",
      })
    );
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("preserves prototype-like JSON documents when the schema declares a string", () => {
    const output = glm5Protocol().parseGeneratedText({
      text: [
        "<tool_call>echo",
        "<arg_key>message</arg_key>",
        '<arg_value>{"constructor":"a normal class name","prototype":"design prototype"}</arg_value>',
        "</tool_call>",
      ].join(""),
      tools: glm5Tools,
    });

    expect(toolCallInput(output)).toEqual({
      message:
        '{"constructor":"a normal class name","prototype":"design prototype"}',
    });
  });

  it("rejects duplicate keys inside structured JSON argument values", () => {
    const output = glm5Protocol().parseGeneratedText({
      text: [
        "<tool_call>typed_action",
        "<arg_key>config</arg_key>",
        '<arg_value>{"mode":"first","mode":"second"}</arg_value>',
        "</tool_call>",
      ].join(""),
      tools: glm5Tools,
    });

    expect(normalizeContentToolCalls(output)).toEqual([]);
  });

  it("rejects nested duplicate keys even when a property schema is unconstrained", () => {
    const output = glm5Protocol().parseGeneratedText({
      text: [
        "<tool_call>open_action",
        "<arg_key>data</arg_key>",
        '<arg_value>{"a":1,"a":2}</arg_value>',
        "</tool_call>",
      ].join(""),
      tools: glm5Tools,
    });

    expect(normalizeContentToolCalls(output)).toEqual([]);
  });

  it("rejects duplicate keys in the alternate JSON-call recovery form", () => {
    const output = glm5Protocol().parseGeneratedText({
      text: [
        "<tool_call>",
        '{"name":"open_action","arguments":{"x":"first","x":"second"}}',
        "</tool_call>",
      ].join(""),
      tools: glm5Tools,
    });

    expect(normalizeContentToolCalls(output)).toEqual([]);
  });

  it.each(["[1,2", '{"mode":"safe"'])(
    "rejects a truncated structured value instead of loose coercion: %s",
    (value) => {
      const key = value.startsWith("[") ? "tags" : "config";
      const output = glm5Protocol().parseGeneratedText({
        text: `<tool_call>typed_action<arg_key>${key}</arg_key><arg_value>${value}`,
        tools: glm5Tools,
      });

      expect(normalizeContentToolCalls(output)).toEqual([]);
    }
  );
});

describe("glm5Protocol raw delimiter disambiguation", () => {
  it.each([
    "before <arg_key> literal after",
    "before </arg_value> literal after",
    "before <arg_key>city</arg_key><arg_value>literal</arg_value> after",
  ])("preserves tag-like text inside a schema string: %s", (message) => {
    const output = glm5Protocol().parseGeneratedText({
      text: `<tool_call>echo<arg_key>message</arg_key><arg_value>${message}</arg_value></tool_call>`,
      tools: glm5Tools,
    });

    expect(toolCallInput(output)).toEqual({ message });
  });

  it("does not terminate a call at a raw </tool_call> inside a string value", () => {
    const message = "before </tool_call> literal after";
    const output = glm5Protocol().parseGeneratedText({
      text: `<tool_call>echo<arg_key>message</arg_key><arg_value>${message}</arg_value></tool_call>`,
      tools: glm5Tools,
    });

    expect(toolCallInput(output)).toEqual({ message });
    expect(output.filter((part) => part.type === "text")).toEqual([]);
  });

  it.each([
    "before <tool_call> literal after",
    "before < tool_call > literal after",
    "before <tool_call>x</tool_call> literal after",
  ])(
    "does not confuse a raw opening tool marker with a nested call: %s",
    (message) => {
      const output = glm5Protocol().parseGeneratedText({
        text: `<tool_call>echo<arg_key>message</arg_key><arg_value>${message}</arg_value></tool_call>`,
        tools: glm5Tools,
      });

      expect(toolCallInput(output)).toEqual({ message });
      expect(output.filter((part) => part.type === "text")).toEqual([]);
    }
  );

  it("fails closed when a nested opening marker has no structurally clean outer close", () => {
    for (const nested of ["<tool_call>ping</tool_call>", "<tool_call>ping"]) {
      const onError = vi.fn();
      const output = glm5Protocol().parseGeneratedText({
        text: [
          "<tool_call>echo",
          "<arg_key>message</arg_key><arg_value>unsafe ",
          nested,
        ].join(""),
        tools: glm5Tools,
        options: { onError },
      });

      expect(normalizeContentToolCalls(output), nested).toEqual([]);
      expect(onError).toHaveBeenCalledWith(
        "Could not parse GLM-5.2 tool call.",
        expect.objectContaining({ dropReason: "malformed-glm5-tool-call" })
      );
    }
  });

  it("bounds close-candidate scanning and fails closed when the limit is exceeded", () => {
    const onError = vi.fn();
    const message = "x</tool_call>".repeat(300);
    const output = glm5Protocol().parseGeneratedText({
      text: `<tool_call>echo<arg_key>message</arg_key><arg_value>${message}</arg_value></tool_call>`,
      tools: glm5Tools,
      options: { onError },
    });

    expect(normalizeContentToolCalls(output)).toEqual([]);
    expect(onError).toHaveBeenCalledWith(
      "Could not parse GLM-5.2 tool call.",
      expect.objectContaining({ dropReason: "malformed-glm5-tool-call" })
    );
  });

  it.each([
    "before </tool_call> literal after",
    "before <tool_call> literal after",
    "before <tool_call>x</tool_call> literal after",
  ])(
    "extracts the complete raw segment across a literal marker: %s",
    (message) => {
      const call = `<tool_call>echo<arg_key>message</arg_key><arg_value>${message}</arg_value></tool_call>`;
      const text = `prefix ${call} suffix`;

      expect(
        glm5Protocol().extractToolCallSegments?.({ text, tools: glm5Tools })
      ).toEqual([call]);
    }
  );

  it("does not extract a recovery-only segment containing a nested opening marker", () => {
    const text = [
      "<tool_call>echo",
      "<arg_key>message</arg_key><arg_value>unsafe </tool_call> ",
      "<tool_call>ping</tool_call>",
    ].join("");

    expect(
      glm5Protocol().extractToolCallSegments?.({ text, tools: glm5Tools })
    ).toEqual([]);
    expect(
      normalizeContentToolCalls(
        glm5Protocol().parseGeneratedText({ text, tools: glm5Tools })
      )
    ).toEqual([]);
  });

  it("resynchronizes after a structurally closed rejected call", () => {
    const rejected = [
      "<tool_call>echo",
      "<arg_key>message</arg_key><arg_value>first</arg_value>",
      "<arg_key>message</arg_key><arg_value>second</arg_value>",
      "</tool_call>",
    ].join("");
    const valid = "<tool_call>ping</tool_call>";
    const protocol = glm5Protocol();

    expect(
      normalizeContentToolCalls(
        protocol.parseGeneratedText({
          text: rejected + valid,
          tools: glm5Tools,
        })
      )
    ).toEqual([{ toolName: "ping", input: {} }]);
    expect(
      protocol.extractToolCallSegments?.({
        text: rejected + valid,
        tools: glm5Tools,
      })
    ).toEqual([valid]);
  });
});

describe("glm5Protocol dynamic object properties", () => {
  it("accepts additionalProperties and patternProperties keys", () => {
    const tools: LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "dynamic",
        inputSchema: {
          type: "object",
          properties: { fixed: { type: "string" } },
          patternProperties: { "^count_": { type: "integer" } },
          additionalProperties: { type: "boolean" },
        },
      },
    ];
    const output = glm5Protocol().parseGeneratedText({
      text: [
        "<tool_call>dynamic",
        "<arg_key>fixed</arg_key><arg_value>ok</arg_value>",
        "<arg_key>count_a</arg_key><arg_value>3</arg_value>",
        "<arg_key>enabled</arg_key><arg_value>true</arg_value>",
        "</tool_call>",
      ].join(""),
      tools,
    });

    expect(toolCallInput(output)).toEqual({
      fixed: "ok",
      count_a: 3,
      enabled: true,
    });
  });
});
