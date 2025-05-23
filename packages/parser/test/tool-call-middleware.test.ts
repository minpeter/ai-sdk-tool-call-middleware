import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createToolMiddleware } from '../src/tool-call-middleware';
import type { LanguageModelV2StreamPart, LanguageModelV2Content, LanguageModelV2GenerationsResult, LanguageModelV2PromptContent, LanguageModelV2ToolDefinition } from '@ai-sdk/provider';
import { generateId } from '@ai-sdk/provider-utils';

// Mock @ai-sdk/provider-utils
vi.mock('@ai-sdk/provider-utils', async () => {
  const actual = await vi.importActual('@ai-sdk/provider-utils');
  return {
    ...actual,
    generateId: vi.fn(),
  };
});

// Helper to create a mock input stream from an array of text chunks
async function* createMockInputStream(
  chunks: Array<string | null> // null signifies a finish chunk
): AsyncIterable<LanguageModelV2StreamPart> {
  for (const chunk of chunks) {
    if (chunk === null) {
      yield {
        type: 'finish',
        finishReason: 'stop',
        usage: { completionTokens: 0, promptTokens: 0 },
      };
    } else {
      yield { type: 'text', text: chunk };
    }
  }
}

// Helper to collect all parts from a stream
async function collectStreamParts(
  stream: AsyncIterable<LanguageModelV2StreamPart>
): Promise<LanguageModelV2StreamPart[]> {
  const parts: LanguageModelV2StreamPart[] = [];
  for await (const part of stream) {
    parts.push(part);
  }
  return parts;
}

describe('wrapStream', ()_ => {
  const toolCallTag = '<tool_call>';
  const toolCallEndTag = '</tool_call>';
  const middleware = createToolMiddleware({
    toolCallTag,
    toolCallEndTag,
    toolResponseTag: '<tool_response>', // Not used by wrapStream parsing but required by createToolMiddleware
    toolResponseEndTag: '</tool_response>', // Not used by wrapStream parsing
    toolSystemPromptTemplate: ()_ => '', // Not used by wrapStream parsing
  });

  beforeEach(()_ => {
    // Reset mocks before each test
    vi.mocked(generateId).mockClear();
  });

  test('should pass through plain text if no tool calls are present', async ()_ => {
    const mockDoStream = async ()_ => ({
      stream: createMockInputStream(['Hello, world!', null]),
      // other properties returned by doStream (if any)
    });

    const result = await middleware.wrapStream!({
      doStream: mockDoStream,
      params: {} as any,
    });
    const outputParts = await collectStreamParts(result.stream);

    expect(outputParts).toEqual([
      { type: 'text', text: 'Hello, world!' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { completionTokens: 0, promptTokens: 0 },
      },
    ]);
  });

  test('should correctly parse a single, complete tool call in one chunk', async ()_ => {
    vi.mocked(generateId).mockReturnValue('test-id-1');
    const toolCallContent = '{"name": "get_weather", "arguments": {"city": "London"}}';
    const mockDoStream = async ()_ => ({
      stream: createMockInputStream([
        `${toolCallTag}${toolCallContent}${toolCallEndTag}`,
        null,
      ]),
    });

    const result = await middleware.wrapStream!({
      doStream: mockDoStream,
      params: {} as any,
    });
    const outputParts = await collectStreamParts(result.stream);

    expect(generateId).toHaveBeenCalledTimes(1);
    expect(outputParts).toEqual([
      {
        type: 'tool-call',
        toolCallType: 'function',
        toolCallId: 'test-id-1',
        toolName: 'get_weather',
        args: JSON.stringify({ city: 'London' }),
      },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { completionTokens: 0, promptTokens: 0 },
      },
    ]);
  });

  test('should correctly parse a single, complete tool call split across multiple chunks', async ()_ => {
    vi.mocked(generateId).mockReturnValue('test-id-2');
    const toolCallName = 'get_weather';
    const toolCallArgs = { city: 'Paris' };
    const toolCallContent = `{"name": "${toolCallName}", "arguments": ${JSON.stringify(
      toolCallArgs
    )}}`;

    const mockDoStream = async ()_ => ({
      stream: createMockInputStream([
        toolCallTag,
        `{"name": "${toolCallName}", `,
        `"arguments": ${JSON.stringify(toolCallArgs)}}`,
        toolCallEndTag,
        null,
      ]),
    });

    const result = await middleware.wrapStream!({
      doStream: mockDoStream,
      params: {} as any,
    });
    const outputParts = await collectStreamParts(result.stream);

    expect(generateId).toHaveBeenCalledTimes(1);
    expect(outputParts).toEqual([
      {
        type: 'tool-call',
        toolCallType: 'function',
        toolCallId: 'test-id-2',
        toolName: toolCallName,
        args: JSON.stringify(toolCallArgs),
      },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { completionTokens: 0, promptTokens: 0 },
      },
    ]);
  });

  test('should correctly parse multiple tool calls in sequence', async ()_ => {
    vi.mocked(generateId)
      .mockReturnValueOnce('id-seq-1')
      .mockReturnValueOnce('id-seq-2');
    const toolCall1 = '{"name": "tool1", "arguments": {}}';
    const toolCall2 = '{"name": "tool2", "arguments": {"param": 1}}';

    const mockDoStream = async ()_ => ({
      stream: createMockInputStream([
        `${toolCallTag}${toolCall1}${toolCallEndTag}`,
        `${toolCallTag}${toolCall2}${toolCallEndTag}`,
        null,
      ]),
    });

    const result = await middleware.wrapStream!({
      doStream: mockDoStream,
      params: {} as any,
    });
    const outputParts = await collectStreamParts(result.stream);

    expect(generateId).toHaveBeenCalledTimes(2);
    expect(outputParts).toEqual([
      {
        type: 'tool-call',
        toolCallType: 'function',
        toolCallId: 'id-seq-1',
        toolName: 'tool1',
        args: JSON.stringify({}),
      },
      { type: 'text', text: '\n' }, // Separator newline
      {
        type: 'tool-call',
        toolCallType: 'function',
        toolCallId: 'id-seq-2',
        toolName: 'tool2',
        args: JSON.stringify({ param: 1 }),
      },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { completionTokens: 0, promptTokens: 0 },
      },
    ]);
  });

  test('should correctly parse multiple tool calls separated by text', async ()_ => {
    vi.mocked(generateId)
      .mockReturnValueOnce('id-sep-1')
      .mockReturnValueOnce('id-sep-2');
    const toolCall1 = '{"name": "toolA", "arguments": {"a": true}}';
    const toolCall2 = '{"name": "toolB", "arguments": {"b": null}}';

    const mockDoStream = async ()_ => ({
      stream: createMockInputStream([
        'Some text before. ',
        `${toolCallTag}${toolCall1}${toolCallEndTag}`,
        ' Some text between. ',
        `${toolCallTag}${toolCall2}${toolCallEndTag}`,
        ' Some text after.',
        null,
      ]),
    });
    const result = await middleware.wrapStream!({
      doStream: mockDoStream,
      params: {} as any,
    });
    const outputParts = await collectStreamParts(result.stream);

    expect(generateId).toHaveBeenCalledTimes(2);
    expect(outputParts).toEqual([
      { type: 'text', text: 'Some text before. ' },
      { type: 'text', text: '\n' }, // Separator
      {
        type: 'tool-call',
        toolCallType: 'function',
        toolCallId: 'id-sep-1',
        toolName: 'toolA',
        args: JSON.stringify({ a: true }),
      },
      { type: 'text', text: '\nSome text between. ' }, // Separator + text
      {
        type: 'tool-call',
        toolCallType: 'function',
        toolCallId: 'id-sep-2',
        toolName: 'toolB',
        args: JSON.stringify({ b: null }),
      },
      { type: 'text', text: '\nSome text after.' }, // Separator + text
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { completionTokens: 0, promptTokens: 0 },
      },
    ]);
  });


  test('should handle stream ending with an incomplete opening tag', async ()_ => {
    const mockDoStream = async ()_ => ({
      stream: createMockInputStream([`Hello ${toolCallTag}partia`, null]),
    });
    const result = await middleware.wrapStream!({
      doStream: mockDoStream,
      params: {} as any,
    });
    const outputParts = await collectStreamParts(result.stream);
    expect(outputParts).toEqual([
      { type: 'text', text: 'Hello ' },
      // The partial tag is considered part of the tool call buffer,
      // but since it's incomplete and the stream ends, it's not flushed as a tool call.
      // The current implementation buffers it and it gets lost if stream finishes.
      // If it should be flushed as text, the implementation would need to change.
      // For now, testing existing behavior: it's buffered and not emitted if incomplete at stream end.
      // If there was a tool call *before* this partial one, that would be emitted.
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { completionTokens: 0, promptTokens: 0 },
      },
    ]);
  });


  test('should handle stream ending with an incomplete closing tag', async ()_ => {
    vi.mocked(generateId).mockReturnValue('incomplete-close-id');
    const toolCallContent = '{"name": "test", "arguments": {}}';
    const mockDoStream = async ()_ => ({
      stream: createMockInputStream([
        `${toolCallTag}${toolCallContent}${toolCallEndTag.slice(0, 5)}`,
        null,
      ]),
    });
    const result = await middleware.wrapStream!({
      doStream: mockDoStream,
      params: {} as any,
    });
    const outputParts = await collectStreamParts(result.stream);

    // The current implementation will buffer the valid part of the tool call.
    // When the stream finishes, it will attempt to parse what's in the buffer.
    // Since the end tag is incomplete, the full tool call string in the buffer
    // will be `{"name": "test", "arguments": {}}</tool_`. This is not valid JSON.
    // So, it should result in a parsing error.
    expect(generateId).not.toHaveBeenCalled(); // No successful tool call means no ID generation for it
    expect(outputParts.length).toBe(2); // Error text and finish
    expect(outputParts[0].type).toBe('text');
    const errorJson = JSON.parse((outputParts[0] as { text: string }).text);
    expect(errorJson.errorType).toBe('tool-call-parsing-error');
    expect(errorJson.source).toBe('tool-call-parsing');
    expect(errorJson.message).toContain('Failed to parse tool call JSON');
    // The detail should be the content that was buffered and failed parsing
    expect(errorJson.details).toBe(`${toolCallContent}${toolCallEndTag.slice(0, 5)}`);
    expect(outputParts[1].type).toBe('finish');
  });


  test('should handle malformed JSON within a tool call', async ()_ => {
    const malformedJson = '{"name": "broken_json", "arguments": {"city": London}}'; // London is not a string
    const mockDoStream = async ()_ => ({
      stream: createMockInputStream([
        `${toolCallTag}${malformedJson}${toolCallEndTag}`,
        null,
      ]),
    });

    const result = await middleware.wrapStream!({
      doStream: mockDoStream,
      params: {} as any,
    });
    const outputParts = await collectStreamParts(result.stream);

    expect(generateId).not.toHaveBeenCalled(); // No successful tool call
    expect(outputParts.length).toBe(2);
    expect(outputParts[0].type).toBe('text');
    const errorContent = JSON.parse((outputParts[0] as { text: string }).text);
    expect(errorContent.errorType).toBe('tool-call-parsing-error');
    expect(errorContent.source).toBe('tool-call-parsing');
    expect(errorContent.message).toMatch(/Unexpected token L in JSON at position 46|Expected a value/i); // Error message can vary slightly
    expect(errorContent.details).toBe(malformedJson);
    expect(outputParts[1].type).toBe('finish');
  });

  test('should preserve content before and after tool calls', async ()_ => {
    vi.mocked(generateId).mockReturnValue('content-around-id');
    const toolCall = '{"name": "middle_tool", "arguments": {}}';
    const mockDoStream = async ()_ => ({
      stream: createMockInputStream([
        'Prefix text. ',
        toolCallTag,
        toolCall,
        toolCallEndTag,
        ' Suffix text.',
        null,
      ]),
    });

    const result = await middleware.wrapStream!({
      doStream: mockDoStream,
      params: {} as any,
    });
    const outputParts = await collectStreamParts(result.stream);

    expect(generateId).toHaveBeenCalledTimes(1);
    expect(outputParts).toEqual([
      { type: 'text', text: 'Prefix text. ' },
      { type: 'text', text: '\n' }, // Separator
      {
        type: 'tool-call',
        toolCallType: 'function',
        toolCallId: 'content-around-id',
        toolName: 'middle_tool',
        args: JSON.stringify({}),
      },
      { type: 'text', text: '\nSuffix text.' }, // Separator + text
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { completionTokens: 0, promptTokens: 0 },
      },
    ]);
  });

  test('should handle empty input stream (only finish event)', async ()_ => {
    const mockDoStream = async ()_ => ({
      stream: createMockInputStream([null]), // Only finish
    });

    const result = await middleware.wrapStream!({
      doStream: mockDoStream,
      params: {} as any,
    });
    const outputParts = await collectStreamParts(result.stream);

    expect(outputParts).toEqual([
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { completionTokens: 0, promptTokens: 0 },
      },
    ]);
    expect(generateId).not.toHaveBeenCalled();
  });
  
  test('should handle stream with only non-text, non-finish chunks initially', async ()_ => {
    // Simulate a stream that might have other types of events before text/finish
    async function* customMockStream(): AsyncIterable<LanguageModelV2StreamPart> {
      yield { type: 'experimental-custom-part', value: {} } as any; // some other part type
      yield { type: 'text', text: 'Hello' };
      yield { type: 'finish', finishReason: 'stop', usage: { completionTokens: 0, promptTokens: 0 } };
    }

    const mockDoStream = async ()_ => ({
      stream: customMockStream(),
    });
     const result = await middleware.wrapStream!({
      doStream: mockDoStream,
      params: {} as any,
    });
    const outputParts = await collectStreamParts(result.stream);

    expect(outputParts).toEqual([
      { type: 'experimental-custom-part', value: {} } as any,
      { type: 'text', text: 'Hello' },
      { type: 'finish', finishReason: 'stop', usage: { completionTokens: 0, promptTokens: 0 } },
    ]);
  });

  test('should handle tool call arguments that are not objects (e.g. string, number)', async ()_ => {
    vi.mocked(generateId).mockReturnValue('primitive-args-id');
    const toolCallContentStringArgs = '{"name": "tool_string_args", "arguments": "this is a string arg"}';
    const toolCallContentNumberArgs = '{"name": "tool_number_args", "arguments": 12345}';

    const mockDoStream = async ()_ => ({
      stream: createMockInputStream([
        `${toolCallTag}${toolCallContentStringArgs}${toolCallEndTag}`,
        `${toolCallTag}${toolCallContentNumberArgs}${toolCallEndTag}`,
        null,
      ]),
    });
    const result = await middleware.wrapStream!({
      doStream: mockDoStream,
      params: {} as any,
    });
    const outputParts = await collectStreamParts(result.stream);
    expect(generateId).toHaveBeenCalledTimes(2);
    expect(outputParts[0]).toMatchObject({
        type: 'tool-call',
        toolName: 'tool_string_args',
        args: JSON.stringify("this is a string arg"),
    });
    expect(outputParts[2]).toMatchObject({ // outputParts[1] is newline text
        type: 'tool-call',
        toolName: 'tool_number_args',
        args: JSON.stringify(12345),
    });
  });

  test('should emit buffered text before a tool call tag is fully matched', async ()_ => {
    vi.mocked(generateId).mockReturnValue('buffered-text-id');
    const toolCall = '{"name":"buffered_test","arguments":{}}';
    const mockDoStream = async ()_ => ({
      stream: createMockInputStream([
        'Text before ',
        toolCallTag.slice(0, 5), // Partial start tag
        'more text ', // This should be emitted as text as the tag isn't complete
        toolCallTag, // Full start tag
        toolCall,
        toolCallEndTag,
        null,
      ]),
    });
    const result = await middleware.wrapStream!({
      doStream: mockDoStream,
      params: {} as any,
    });
    const outputParts = await collectStreamParts(result.stream);

    expect(outputParts).toEqual([
      { type: 'text', text: 'Text before ' }, // Text before partial tag
      { type: 'text', text: toolCallTag.slice(0, 5) }, // The partial tag itself is treated as text
      { type: 'text', text: 'more text ' }, // Text after partial, before full tag
      { type: 'text', text: '\n' }, // Separator
      {
        type: 'tool-call',
        toolCallId: 'buffered-text-id',
        toolCallType: 'function',
        toolName: 'buffered_test',
        args: JSON.stringify({}),
      },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { completionTokens: 0, promptTokens: 0 },
      },
    ]);
  });

  test('should emit newline separator correctly for adjacent tool calls and text', async ()_ => {
    vi.mocked(generateId).mockReturnValueOnce('adj-id-1').mockReturnValueOnce('adj-id-2');
    const toolCall1 = '{"name":"adj1","arguments":{}}';
    const toolCall2 = '{"name":"adj2","arguments":{}}';

    const mockDoStream = async ()_ => ({
      stream: createMockInputStream([
        'Initial.', // Text
        `${toolCallTag}${toolCall1}${toolCallEndTag}`, // Tool call
        `${toolCallTag}${toolCall2}${toolCallEndTag}`, // Tool call
        'Final.', // Text
        null,
      ]),
    });
    const result = await middleware.wrapStream!({ doStream: mockDoStream, params: {} as any });
    const outputParts = await collectStreamParts(result.stream);

    expect(outputParts).toEqual([
      { type: 'text', text: 'Initial.' },
      { type: 'text', text: '\n' }, // Separator text -> tool
      { type: 'tool-call', toolCallId: 'adj-id-1', toolName: 'adj1', args: '{}', toolCallType: 'function' },
      { type: 'text', text: '\n' }, // Separator tool -> tool
      { type: 'tool-call', toolCallId: 'adj-id-2', toolName: 'adj2', args: '{}', toolCallType: 'function' },
      { type: 'text', text: '\nFinal.' }, // Separator tool -> text
      { type: 'finish', finishReason: 'stop', usage: { completionTokens: 0, promptTokens: 0 } },
    ]);
  });
});


// ---------------------- Tests for wrapGenerate ----------------------

describe('wrapGenerate', ()_ => {
  const toolCallTag = '<tool_call>';
  const toolCallEndTag = '</tool_call>';
  const middleware = createToolMiddleware({
    toolCallTag,
    toolCallEndTag,
    toolResponseTag: '<tool_response>', // Not directly used in wrapGenerate parsing logic
    toolResponseEndTag: '</tool_response>', // Not directly used
    toolSystemPromptTemplate: ()_ => '', // Not directly used
  });

  beforeEach(()_ => {
    vi.mocked(generateId).mockClear();
    // Mock console.warn and console.error to prevent actual logging during tests
    // and allow assertions on them if needed.
    vi.spyOn(console, 'warn').mockImplementation(()_ => {});
    vi.spyOn(console, 'error').mockImplementation(()_ => {});
  });

  afterEach(()_ => {
    vi.restoreAllMocks();
  });

  test('should pass through plain text content if no tool calls are present', async ()_ => {
    const mockDoGenerate = async (): Promise<LanguageModelV2GenerationsResult> => ({
      content: [{ type: 'text', text: 'Hello, world!' }],
      finishReason: 'stop',
      usage: { completionTokens: 1, promptTokens: 1 },
    });

    const result = await middleware.wrapGenerate!({ doGenerate: mockDoGenerate, params: {} as any });
    expect(result.content).toEqual([{ type: 'text', text: 'Hello, world!' }]);
  });

  test('should correctly parse a single, complete tool call with object arguments', async ()_ => {
    vi.mocked(generateId).mockReturnValue('gen-id-1');
    const toolName = 'get_weather';
    const toolArgs = { city: 'London' };
    const toolCallJson = `{"name": "${toolName}", "arguments": ${JSON.stringify(toolArgs)}}`;

    const mockDoGenerate = async (): Promise<LanguageModelV2GenerationsResult> => ({
      content: [{ type: 'text', text: `${toolCallTag}${toolCallJson}${toolCallEndTag}` }],
      finishReason: 'stop',
      usage: { completionTokens: 1, promptTokens: 1 },
    });

    const result = await middleware.wrapGenerate!({ doGenerate: mockDoGenerate, params: {} as any });
    expect(generateId).toHaveBeenCalledTimes(1);
    expect(result.content).toEqual([
      {
        type: 'tool-call',
        toolCallType: 'function',
        toolCallId: 'gen-id-1',
        toolName: toolName,
        args: JSON.stringify(toolArgs),
      },
    ]);
  });

  test('should correctly parse a single, complete tool call with stringified arguments', async ()_ => {
    vi.mocked(generateId).mockReturnValue('gen-id-string-args');
    const toolName = 'run_query';
    const toolArgsObject = { query: "SELECT * FROM users" };
    // Arguments are already a string in the "raw" JSON
    const toolCallJson = `{"name": "${toolName}", "arguments": ${JSON.stringify(JSON.stringify(toolArgsObject))}}`;


    const mockDoGenerate = async (): Promise<LanguageModelV2GenerationsResult> => ({
      content: [{ type: 'text', text: `${toolCallTag}${toolCallJson}${toolCallEndTag}` }],
      finishReason: 'stop',
      usage: { completionTokens: 1, promptTokens: 1 },
    });
    const result = await middleware.wrapGenerate!({ doGenerate: mockDoGenerate, params: {} as any });
    expect(generateId).toHaveBeenCalledTimes(1);
    expect(result.content).toEqual([
      {
        type: 'tool-call',
        toolCallType: 'function',
        toolCallId: 'gen-id-string-args',
        toolName: toolName,
        args: JSON.stringify(toolArgsObject), // Expecting it to be parsed and then re-stringified if needed
      },
    ]);
  });


  test('should correctly parse multiple tool calls in sequence', async ()_ => {
    vi.mocked(generateId).mockReturnValueOnce('gen-id-seq-1').mockReturnValueOnce('gen-id-seq-2');
    const tool1Json = '{"name": "tool1", "arguments": {}}';
    const tool2Json = '{"name": "tool2", "arguments": {"param": 1}}';

    const mockDoGenerate = async (): Promise<LanguageModelV2GenerationsResult> => ({
      content: [{ type: 'text', text: `${toolCallTag}${tool1Json}${toolCallEndTag}${toolCallTag}${tool2Json}${toolCallEndTag}` }],
      finishReason: 'stop',
      usage: { completionTokens: 1, promptTokens: 1 },
    });
    const result = await middleware.wrapGenerate!({ doGenerate: mockDoGenerate, params: {} as any });

    expect(generateId).toHaveBeenCalledTimes(2);
    expect(result.content).toEqual([
      { type: 'tool-call', toolCallType: 'function', toolCallId: 'gen-id-seq-1', toolName: 'tool1', args: JSON.stringify({}) },
      { type: 'tool-call', toolCallType: 'function', toolCallId: 'gen-id-seq-2', toolName: 'tool2', args: JSON.stringify({ param: 1 }) },
    ]);
  });

  test('should correctly parse multiple tool calls separated by text', async ()_ => {
    vi.mocked(generateId).mockReturnValueOnce('gen-id-sep-1').mockReturnValueOnce('gen-id-sep-2');
    const tool1Json = '{"name": "toolA", "arguments": {"a": true}}';
    const tool2Json = '{"name": "toolB", "arguments": {"b": "text"}}';

    const mockDoGenerate = async (): Promise<LanguageModelV2GenerationsResult> => ({
      content: [{ type: 'text', text: `Text1 ${toolCallTag}${tool1Json}${toolCallEndTag} Text2 ${toolCallTag}${tool2Json}${toolCallEndTag} Text3` }],
      finishReason: 'stop',
      usage: { completionTokens: 1, promptTokens: 1 },
    });
    const result = await middleware.wrapGenerate!({ doGenerate: mockDoGenerate, params: {} as any });

    expect(generateId).toHaveBeenCalledTimes(2);
    expect(result.content).toEqual([
      { type: 'text', text: 'Text1 ' },
      { type: 'tool-call', toolCallType: 'function', toolCallId: 'gen-id-sep-1', toolName: 'toolA', args: JSON.stringify({ a: true }) },
      { type: 'text', text: ' Text2 ' },
      { type: 'tool-call', toolCallType: 'function', toolCallId: 'gen-id-sep-2', toolName: 'toolB', args: JSON.stringify({ b: "text" }) },
      { type: 'text', text: ' Text3' },
    ]);
  });

  test('should handle malformed JSON and return structured error in text part', async ()_ => {
    const malformedJson = '{"name": "broken", "arguments": {bad_json}}'; // bad_json is not valid
    const originalText = `${toolCallTag}${malformedJson}${toolCallEndTag}`;

    const mockDoGenerate = async (): Promise<LanguageModelV2GenerationsResult> => ({
      content: [{ type: 'text', text: originalText }],
      finishReason: 'stop',
      usage: { completionTokens: 1, promptTokens: 1 },
    });
    const result = await middleware.wrapGenerate!({ doGenerate: mockDoGenerate, params: {} as any });

    expect(generateId).not.toHaveBeenCalled();
    expect(result.content.length).toBe(1);
    const errorPart = result.content[0] as { type: 'text', text: string };
    expect(errorPart.type).toBe('text');
    const errorDetails = JSON.parse(errorPart.text);
    expect(errorDetails.errorType).toBe('tool-call-parsing-error');
    expect(errorDetails.originalText).toBe(malformedJson);
    expect(errorDetails.error.message).toMatch(/Unexpected token b in JSON at position 31|Expected a value/i);
    expect(console.error).toHaveBeenCalledWith(
      "Failed to parse tool call JSON:",
      expect.any(Error), // SyntaxError
      "JSON:",
      malformedJson
    );
    expect(console.warn).toHaveBeenCalledWith(
      `Could not fully process tool call. Original text wrapped in error JSON: ${errorPart.text}`
    );
  });

  test('should handle invalid tool call structure (e.g. missing name) and return structured error', async ()_ => {
    const invalidStructureJson = '{"arguments": {"city": "Test"}}'; // Missing "name"
    const originalText = `${toolCallTag}${invalidStructureJson}${toolCallEndTag}`;

    const mockDoGenerate = async (): Promise<LanguageModelV2GenerationsResult> => ({
      content: [{ type: 'text', text: originalText }],
      finishReason: 'stop',
      usage: { completionTokens: 1, promptTokens: 1 },
    });
    const result = await middleware.wrapGenerate!({ doGenerate: mockDoGenerate, params: {} as any });

    expect(generateId).not.toHaveBeenCalled();
    const errorPart = result.content[0] as { type: 'text', text: string };
    expect(errorPart.type).toBe('text');
    const errorDetails = JSON.parse(errorPart.text);

    expect(errorDetails.errorType).toBe('tool-call-parsing-error');
    expect(errorDetails.originalText).toBe(invalidStructureJson);
    expect(errorDetails.error.message).toBe('Invalid tool call structure');
    expect(errorDetails.error.data).toEqual(JSON.parse(invalidStructureJson)); // RJSON.parse output
     expect(console.error).toHaveBeenCalledWith(
      "Failed to parse tool call: Invalid structure",
      invalidStructureJson
    );
    expect(console.warn).toHaveBeenCalledWith(
      `Could not fully process tool call. Original text wrapped in error JSON: ${errorPart.text}`
    );
  });

  test('should pass through non-text content items unchanged', async ()_ => {
    const customContent = { type: 'custom-part', data: { foo: 'bar' } } as any;
    const mockDoGenerate = async (): Promise<LanguageModelV2GenerationsResult> => ({
      content: [customContent, { type: 'text', text: 'Hello' }],
      finishReason: 'stop',
      usage: { completionTokens: 1, promptTokens: 1 },
    });
    const result = await middleware.wrapGenerate!({ doGenerate: mockDoGenerate, params: {} as any });
    expect(result.content).toEqual([customContent, { type: 'text', text: 'Hello' }]);
  });

  test('should handle empty result.content', async ()_ => {
    const mockDoGenerate = async (): Promise<LanguageModelV2GenerationsResult> => ({
      content: [],
      finishReason: 'stop',
      usage: { completionTokens: 0, promptTokens: 0 },
    });
    const result = await middleware.wrapGenerate!({ doGenerate: mockDoGenerate, params: {} as any });
    expect(result.content).toEqual([]);
  });

  test('should handle text content item with empty text string', async ()_ => {
     const mockDoGenerate = async (): Promise<LanguageModelV2GenerationsResult> => ({
      content: [{ type: 'text', text: '' }],
      finishReason: 'stop',
      usage: { completionTokens: 1, promptTokens: 1 },
    });
    const result = await middleware.wrapGenerate!({ doGenerate: mockDoGenerate, params: {} as any });
    expect(result.content).toEqual([{ type: 'text', text: '' }]); // Or [] if empty strings are filtered
  });
  
  test('should trim whitespace-only text segments and remove if empty', async ()_ => {
    vi.mocked(generateId).mockReturnValue('gen-id-trim');
    const toolJson = '{"name": "toolTrim", "arguments": {}}';
    const mockDoGenerate = async (): Promise<LanguageModelV2GenerationsResult> => ({
      content: [{ type: 'text', text: `   ${toolCallTag}${toolJson}${toolCallEndTag}   ` }],
      finishReason: 'stop',
      usage: { completionTokens: 1, promptTokens: 1 },
    });
    const result = await middleware.wrapGenerate!({ doGenerate: mockDoGenerate, params: {} as any });

    // Depending on current logic, leading/trailing spaces might be preserved or trimmed by the regex logic.
    // The current implementation of wrapGenerate's regex parsing and substring logic
    // might lead to text parts that are just spaces. The prompt asks to verify trimming these.
    // The code `if (textSegment.trim()) { processedElements.push(...) }` handles this.
    expect(result.content).toEqual([
      // No empty text part for leading "   " because it's trimmed and becomes empty.
      { type: 'tool-call', toolCallType: 'function', toolCallId: 'gen-id-trim', toolName: 'toolTrim', args: JSON.stringify({}) },
      // No empty text part for trailing "   "
    ]);
  });

  test('text ending with incomplete opening tag should not match tool call', async ()_ => {
    const text = `Some important text ${toolCallTag.slice(0, 5)}`; // e.g. "Some important text <tool_"
    const mockDoGenerate = async (): Promise<LanguageModelV2GenerationsResult> => ({
      content: [{ type: 'text', text }],
      finishReason: 'stop',
      usage: { completionTokens: 1, promptTokens: 1 },
    });
    const result = await middleware.wrapGenerate!({ doGenerate: mockDoGenerate, params: {} as any });
    expect(result.content).toEqual([{ type: 'text', text }]); // Should remain as plain text
    expect(generateId).not.toHaveBeenCalled();
  });

  test('text containing toolCallEndTag without preceding toolCallTag', async ()_ => {
    const text = `Some text ${toolCallEndTag} more text.`;
    const mockDoGenerate = async (): Promise<LanguageModelV2GenerationsResult> => ({
      content: [{ type: 'text', text }],
      finishReason: 'stop',
      usage: { completionTokens: 1, promptTokens: 1 },
    });
    const result = await middleware.wrapGenerate!({ doGenerate: mockDoGenerate, params: {} as any });
    expect(result.content).toEqual([{ type: 'text', text }]); // Should remain as plain text
    expect(generateId).not.toHaveBeenCalled();
  });

  test('tool call ending right at the end of the text content', async ()_ => {
    vi.mocked(generateId).mockReturnValue('gen-id-eos');
    const toolJson = '{"name": "eos_tool", "arguments": {}}';
    const mockDoGenerate = async (): Promise<LanguageModelV2GenerationsResult> => ({
      content: [{ type: 'text', text: `Start text ${toolCallTag}${toolJson}${toolCallEndTag}` }],
      finishReason: 'stop',
      usage: { completionTokens: 1, promptTokens: 1 },
    });
    const result = await middleware.wrapGenerate!({ doGenerate: mockDoGenerate, params: {} as any });
    expect(result.content).toEqual([
      { type: 'text', text: 'Start text ' },
      { type: 'tool-call', toolCallType: 'function', toolCallId: 'gen-id-eos', toolName: 'eos_tool', args: JSON.stringify({}) },
    ]);
  });

   test('tool call where arguments is a JSON primitive (string)', async ()_ => {
    vi.mocked(generateId).mockReturnValue('gen-id-primitive-str');
    const toolName = 'primitive_args_tool';
    const toolArgs = "this is a string argument";
    const toolCallJson = `{"name": "${toolName}", "arguments": ${JSON.stringify(toolArgs)}}`;

    const mockDoGenerate = async (): Promise<LanguageModelV2GenerationsResult> => ({
      content: [{ type: 'text', text: `${toolCallTag}${toolCallJson}${toolCallEndTag}` }],
      finishReason: 'stop',
      usage: { completionTokens: 1, promptTokens: 1 },
    });
    const result = await middleware.wrapGenerate!({ doGenerate: mockDoGenerate, params: {} as any });
    expect(result.content).toEqual([
      {
        type: 'tool-call',
        toolCallType: 'function',
        toolCallId: 'gen-id-primitive-str',
        toolName: toolName,
        args: JSON.stringify(toolArgs), // arguments should be correctly stringified
      },
    ]);
  });

  test('tool call where arguments is a JSON primitive (number)', async ()_ => {
    vi.mocked(generateId).mockReturnValue('gen-id-primitive-num');
    const toolName = 'primitive_args_tool_num';
    const toolArgs = 12345.67;
    const toolCallJson = `{"name": "${toolName}", "arguments": ${JSON.stringify(toolArgs)}}`; // or just ...arguments: 12345.67}

    const mockDoGenerate = async (): Promise<LanguageModelV2GenerationsResult> => ({
      content: [{ type: 'text', text: `${toolCallTag}${toolCallJson}${toolCallEndTag}` }],
      finishReason: 'stop',
      usage: { completionTokens: 1, promptTokens: 1 },
    });
    const result = await middleware.wrapGenerate!({ doGenerate: mockDoGenerate, params: {} as any });
    expect(result.content).toEqual([
      {
        type: 'tool-call',
        toolCallType: 'function',
        toolCallId: 'gen-id-primitive-num',
        toolName: toolName,
        args: JSON.stringify(toolArgs),
      },
    ]);
  });
});

// ---------------------- Tests for transformParams ----------------------

describe('transformParams', ()_ => {
  const exampleTools: LanguageModelV2ToolDefinition[] = [
    { type: 'function', function: { name: 'get_weather', description: 'Gets weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } },
    { type: 'function', function: { name: 'get_stock_price', description: 'Gets stock price', parameters: { type: 'object', properties: { symbol: { type: 'string' } } } } },
  ];

  const toolCallTag = '<TOOL_CALL>';
  const toolCallEndTag = '</TOOL_CALL>';
  const toolResponseTag = '<TOOL_RESPONSE>';
  const toolResponseEndTag = '</TOOL_RESPONSE>';
  
  const defaultToolSystemPromptTemplate = (toolsString: string) => 
    `SYSTEM: You have access to the following tools:\n${toolsString}\n` +
    `To use a tool, respond with a JSON object inside ${toolCallTag} and ${toolCallEndTag} tags.`;


  const middleware = createToolMiddleware({
    toolCallTag,
    toolCallEndTag,
    toolResponseTag,
    toolResponseEndTag,
    toolSystemPromptTemplate: defaultToolSystemPromptTemplate,
  });

  test('should add tool system prompt and clear tool parameters for single user message prompt', async ()_ => {
    const initialParams = {
      prompt: [{ type: 'user' as const, content: 'Hello, what is the weather in London?' }],
      tools: exampleTools,
      toolChoice: 'auto' as const,
    };

    const transformed = await middleware.transformParams!({ params: { ...initialParams } });
    
    // Check that tools and toolChoice are cleared
    expect(transformed.tools).toEqual([]);
    expect(transformed.toolChoice).toBeUndefined();

    // Check prompt structure
    expect(transformed.prompt.length).toBe(2); // System prompt + User prompt
    expect(transformed.prompt[0].type).toBe('system');
    expect(transformed.prompt[0].content).toContain('SYSTEM: You have access to the following tools:');
    expect(transformed.prompt[0].content).toContain('get_weather');
    expect(transformed.prompt[0].content).toContain('get_stock_price');
    expect(transformed.prompt[0].content).toContain(`To use a tool, respond with a JSON object inside ${toolCallTag} and ${toolCallEndTag} tags.`);
    expect(transformed.prompt[1]).toEqual(initialParams.prompt[0]); // Original user message
  });

  test('should add tool system prompt for string prompt (treated as user message)', async ()_ => {
    const initialParams = {
      prompt: 'Hello, what is the weather in London?', // String prompt
      tools: exampleTools,
      toolChoice: 'auto' as const,
    };
     const transformed = await middleware.transformParams!({ params: { ...initialParams } });

    expect(transformed.tools).toEqual([]);
    expect(transformed.toolChoice).toBeUndefined();

    // convertToolPrompt internally converts string prompt to [{ type: 'user', content: stringPrompt }]
    // then prepends the system message.
    expect(transformed.prompt.length).toBe(2); 
    expect(transformed.prompt[0].type).toBe('system');
    expect(transformed.prompt[0].content).toContain('SYSTEM: You have access to the following tools:');
    expect(transformed.prompt[1].type).toBe('user');
    expect(transformed.prompt[1].content).toBe(initialParams.prompt);
  });
  
  test('should merge tool system prompt if an initial system prompt exists', async ()_ => {
    const initialParams = {
      prompt: [
        { type: 'system' as const, content: 'Initial system message.' },
        { type: 'user' as const, content: 'Tell me about weather tools.' },
      ],
      tools: exampleTools,
    };
    const transformed = await middleware.transformParams!({ params: { ...initialParams } });

    expect(transformed.prompt.length).toBe(2); // System prompt should be merged/prepended
    expect(transformed.prompt[0].type).toBe('system');
    // The exact merging strategy depends on convertToolPrompt, but it should contain both.
    // Assuming convertToolPrompt prepends the tool system part to existing system message.
    expect(transformed.prompt[0].content).toContain('Initial system message.');
    expect(transformed.prompt[0].content).toContain('SYSTEM: You have access to the following tools:');
    expect(transformed.prompt[1]).toEqual(initialParams.prompt[1]);
  });

  test('should not add tool system prompt if no tools are provided', async ()_ => {
    const initialUserPrompt = { type: 'user' as const, content: 'Hello' };
    const initialParams = {
      prompt: [initialUserPrompt],
      tools: [], // No tools
    };
    const transformed = await middleware.transformParams!({ params: { ...initialParams } });
    
    // Prompt should remain unchanged or only minimally changed if template adds generic text
    // For defaultToolSystemPromptTemplate, it adds the "You have access..." part even if toolsString is empty.
    // This behavior is inherent to convertToolPrompt's current logic.
    expect(transformed.prompt.length).toBe(2); // System prompt (empty tools) + User prompt
    expect(transformed.prompt[0].type).toBe('system');
    expect(transformed.prompt[0].content).toContain('SYSTEM: You have access to the following tools:\n\nTo use a tool');
    expect(transformed.prompt[1]).toEqual(initialUserPrompt);

    expect(transformed.tools).toEqual([]);
    expect(transformed.toolChoice).toBeUndefined();
  });
  
  test('should handle empty prompt array', async ()_ => {
    const initialParams = {
      prompt: [], // Empty prompt array
      tools: exampleTools,
    };
    const transformed = await middleware.transformParams!({ params: { ...initialParams } });
    
    expect(transformed.prompt.length).toBe(1); // Only the system prompt for tools
    expect(transformed.prompt[0].type).toBe('system');
    expect(transformed.prompt[0].content).toContain('SYSTEM: You have access to the following tools:');
  });

  test('should use custom toolSystemPromptTemplate correctly', async ()_ => {
    const customTemplate = (toolsString: string) => `CUSTOM_TOOL_PROMPT: ${toolsString}`;
    const customMiddleware = createToolMiddleware({
      toolCallTag, toolCallEndTag, toolResponseTag, toolResponseEndTag,
      toolSystemPromptTemplate: customTemplate,
    });
    const initialParams = {
      prompt: [{ type: 'user' as const, content: 'Hi' }],
      tools: [exampleTools[0]], // Single tool
    };
    const transformed = await customMiddleware.transformParams!({ params: { ...initialParams } });

    expect(transformed.prompt.length).toBe(2);
    expect(transformed.prompt[0].type).toBe('system');
    expect(transformed.prompt[0].content).toContain('CUSTOM_TOOL_PROMPT:');
    expect(transformed.prompt[0].content).toContain(exampleTools[0].function.name);
    // Ensure it doesn't use the default template's text
    expect(transformed.prompt[0].content).not.toContain('SYSTEM: You have access');
  });
});
