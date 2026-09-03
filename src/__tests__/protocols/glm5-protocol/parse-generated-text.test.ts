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

const anchoredTools = [...glm5Tools, aceBareCallTool];
const tools = anchoredTools;

describe("parse-generated-text.test split 1", () => {
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
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

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

  it("recovers a unique generated-name digest or its exact digestless stem", () => {
    const digestTools: LanguageModelV4FunctionTool[] = [
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
      tools: digestTools,
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
    const strayCloseTools: LanguageModelV4FunctionTool[] = [
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
      tools: strayCloseTools,
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
    const generatedNameTools: LanguageModelV4FunctionTool[] = names.map(
      (name) => ({
        type: "function",
        name,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      })
    );
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
      tools: generatedNameTools,
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
});
