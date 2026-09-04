import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import {
  type ForeignRecoveryContext,
  salvageForeignBlockAtFinish,
  tryConsumeForeignToolCallBlock,
} from "../../../../core/protocols/yaml-xml-stream-foreign-recovery";

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "get_weather",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
];

interface RecoveryResult {
  readonly consumed?: boolean;
  readonly events: LanguageModelV4StreamPart[];
  readonly flushes: (string | undefined)[];
  readonly remainingBuffer: string;
}

type RecoveryAction =
  | ((
      context: ForeignRecoveryContext,
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
    ) => boolean)
  | ((
      context: ForeignRecoveryContext,
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
    ) => void);

async function runRecovery(
  initialBuffer: string,
  action: RecoveryAction
): Promise<RecoveryResult> {
  let buffer = initialBuffer;
  let consumed: boolean | undefined;
  const flushes: (string | undefined)[] = [];
  const stream = new TransformStream<never, LanguageModelV4StreamPart>({
    start(controller) {
      const context: ForeignRecoveryContext = {
        flushText(currentController, text) {
          flushes.push(text);
          if (text) {
            currentController.enqueue({
              type: "text-delta",
              id: "salvage-text",
              delta: text,
            });
          }
        },
        getBuffer: () => buffer,
        setBuffer: (value) => {
          buffer = value;
        },
        toolNames: ["get_weather"],
        tools,
      };
      const result = action(context, controller);
      if (typeof result === "boolean") {
        consumed = result;
      }
      controller.terminate();
    },
  });
  const events = await convertReadableStreamToArray(stream.readable);
  return { consumed, events, flushes, remainingBuffer: buffer };
}

const completeCall =
  '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call>';
const sensitiveCall =
  '<tool_call>{"name":"get_weather","arguments":{"constructor":true}}</tool_call>';

describe("YAML-XML foreign stream recovery coverage", () => {
  it.each([
    ["plain text", false],
    ['<tool_call>{"name":"get_weather"}', false],
    [`<get_weather>city: Seoul</get_weather>${completeCall}`, false],
    ["<tool_call>not json <get_weather></tool_call>", false],
  ])(
    "leaves %s buffered when incremental recovery cannot consume it",
    async (buffer, expected) => {
      // Given an incomplete, absent, or YAML-owned foreign-looking block
      // When incremental foreign recovery runs
      const result = await runRecovery(buffer, tryConsumeForeignToolCallBlock);

      // Then no text or tool lifecycle is emitted and the buffer is untouched
      expect(result).toEqual({
        consumed: expected,
        events: [],
        flushes: [],
        remainingBuffer: buffer,
      });
    }
  );

  it("emits a complete tool-input lifecycle and preserves trailing text", async () => {
    // Given a valid foreign call at the buffer start and trailing text
    const buffer = `${completeCall} after`;

    // When the complete block is consumed
    const result = await runRecovery(buffer, tryConsumeForeignToolCallBlock);

    // Then the complete recovered lifecycle is emitted and the suffix remains
    expect(result.consumed).toBe(true);
    expect(result.flushes).toEqual([undefined]);
    expect(result.remainingBuffer).toBe(" after");
    expect(result.events.map((part) => part.type)).toEqual([
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
    ]);
    expect(result.events).toMatchObject([
      { type: "tool-input-start", toolName: "get_weather" },
      { type: "tool-input-delta", delta: '{"city":"Seoul"}' },
      { type: "tool-input-end" },
      { type: "tool-call", toolName: "get_weather", input: '{"city":"Seoul"}' },
    ]);
  });

  it("drops a complete prototype-sensitive block without leaking its text", async () => {
    // Given safe prefix and suffix text around a sensitive foreign block
    const buffer = `before ${sensitiveCall} after`;

    // When incremental recovery consumes the unsafe block
    const result = await runRecovery(buffer, tryConsumeForeignToolCallBlock);

    // Then only the safe prefix is emitted and the suffix remains buffered
    expect(result).toEqual({
      consumed: true,
      events: [{ type: "text-delta", id: "salvage-text", delta: "before " }],
      flushes: ["before "],
      remainingBuffer: " after",
    });
  });

  it("emits an unrecoverable harmless block as text and consumes it", async () => {
    // Given an unsupported but harmless closed foreign block
    const buffer = "before <tool_call>not json</tool_call> after";

    // When incremental recovery consumes the complete block
    const result = await runRecovery(buffer, tryConsumeForeignToolCallBlock);

    // Then the prefix and block remain observable text while the suffix is retained
    expect(result).toEqual({
      consumed: true,
      events: [
        {
          type: "text-delta",
          id: "salvage-text",
          delta: "before <tool_call>not json</tool_call>",
        },
      ],
      flushes: ["before <tool_call>not json</tool_call>"],
      remainingBuffer: " after",
    });
  });

  it.each(["", "ordinary finish text"])(
    "flushes the finish buffer without inventing calls for %s",
    async (buffer) => {
      // Given an empty or ordinary finish buffer
      // When finish-time salvage runs
      const result = await runRecovery(buffer, salvageForeignBlockAtFinish);

      // Then ordinary text is flushed exactly once and the buffer is cleared
      expect(result.events).toEqual(
        buffer
          ? [{ type: "text-delta", id: "salvage-text", delta: buffer }]
          : []
      );
      expect(result.flushes).toEqual(buffer ? [buffer] : []);
      expect(result.remainingBuffer).toBe("");
    }
  );

  it("salvages an unfinished foreign call at finish after prefix text", async () => {
    // Given a valid unterminated foreign block after plain text
    const buffer = `before ${completeCall.replace("</tool_call>", "")}`;

    // When finish-time salvage runs
    const result = await runRecovery(buffer, salvageForeignBlockAtFinish);

    // Then the prefix precedes the recovered lifecycle and the buffer is exhausted
    expect(result.flushes).toEqual(["before ", undefined]);
    expect(result.events.map((part) => part.type)).toEqual([
      "text-delta",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
    ]);
    expect(result.remainingBuffer).toBe("");
  });

  it("drops a prototype-sensitive unfinished block at finish", async () => {
    // Given a sensitive unterminated block after safe text
    const buffer = `before ${sensitiveCall.replace("</tool_call>", "")}`;

    // When finish-time salvage runs
    const result = await runRecovery(buffer, salvageForeignBlockAtFinish);

    // Then only safe prefix text is emitted and all buffered content is consumed
    expect(result).toEqual({
      events: [{ type: "text-delta", id: "salvage-text", delta: "before " }],
      flushes: ["before "],
      remainingBuffer: "",
    });
  });

  it("flushes an unrecoverable harmless unfinished block at finish", async () => {
    // Given an unfinished harmless block
    const buffer = "before <tool_call>not json";

    // When finish-time salvage runs
    const result = await runRecovery(buffer, salvageForeignBlockAtFinish);

    // Then the entire buffer remains observable text and is cleared
    expect(result).toEqual({
      events: [{ type: "text-delta", id: "salvage-text", delta: buffer }],
      flushes: [buffer],
      remainingBuffer: "",
    });
  });
});
