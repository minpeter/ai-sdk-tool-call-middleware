import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolCall,
} from "@ai-sdk/provider";
import YAML from "yaml";
import { generateToolCallId } from "../utils/id";
import {
  createFlushTextHandler,
  extractToolNames,
  formatToolsWithPromptTemplate,
  safeToolCallMetadataError,
  safeToolCallMetadataText,
} from "../utils/protocol-utils";
import { toolCallTextHasPrototypeSensitiveKey } from "../utils/prototype-sensitive-keys";
import {
  emitBufferedToolInputProgressDelta,
  emitFailedBufferedToolInputLifecycle,
  emitFinalizedBufferedToolInputLifecycle,
  enqueueToolInputEndAndCall,
  isPrototypeSensitiveToolCallInputError,
  shouldEmitRawToolCallTextOnError,
  stringifyToolInputWithSchema,
} from "../utils/tool-input-streaming";
import { tryRepairXmlSelfClosingRootWithBody } from "../utils/xml-root-repair";
import {
  findEarliestToolTag,
  findPotentialPartialToolTagStart,
} from "../utils/xml-tool-tag-scanner";
import type { ParserOptions, TCMCoreProtocol } from "./protocol-interface";

export interface YamlXmlProtocolOptions {
  /**
   * Whether to include a system prompt example showing YAML multiline syntax.
   * @default true
   */
  includeMultilineExample?: boolean;
}

import {
  addTextOrForeignToolCalls,
  FOREIGN_TOOL_CALL_CLOSE_RE,
  type ForeignToolCallPart,
  findForeignBlockHoldStart,
  findForeignToolCallOpenStart,
  recoverGatedForeignCalls,
} from "./yaml-xml-foreign-recovery";
import {
  buildSchemaPropNameSet,
  findToolCalls,
  parseYamlContent,
  parseYamlContentForStreamProgress,
  safeYamlFailureCause,
  stripTrailingPartialCloseTag,
  type ToolCallMatch,
  YAML_BLOCK_SCALAR_HEADER_RE,
} from "./yaml-xml-parsing";

function processToolCallMatch(
  text: string,
  tc: ToolCallMatch,
  currentIndex: number,
  processedElements: LanguageModelV4Content[],
  tools: LanguageModelV4FunctionTool[],
  options?: ParserOptions
): number {
  if (tc.startIndex < currentIndex) {
    return currentIndex;
  }

  addTextOrForeignToolCalls(
    text.slice(currentIndex, tc.startIndex),
    processedElements,
    tools
  );

  const result = parseYamlContent(
    tc.content,
    buildSchemaPropNameSet(tc.toolName, tools)
  );
  if (result.ok) {
    try {
      processedElements.push({
        type: "tool-call",
        toolCallId: generateToolCallId(),
        toolName: tc.toolName,
        input: stringifyToolInputWithSchema({
          toolName: tc.toolName,
          args: result.value,
          tools,
        }),
      });
    } catch (error) {
      const originalText = text.slice(tc.startIndex, tc.endIndex);
      options?.onError?.("Could not parse YAML tool call", {
        toolCall: safeToolCallMetadataText(originalText),
        toolName: tc.toolName,
        toolCallId: generateToolCallId(),
        dropReason: "malformed-tool-call-body",
        error: safeToolCallMetadataError(error, originalText),
      });
      if (!toolCallTextHasPrototypeSensitiveKey(originalText)) {
        processedElements.push({ type: "text", text: originalText });
      }
    }
  } else {
    const originalText = text.slice(tc.startIndex, tc.endIndex);
    options?.onError?.("Could not parse YAML tool call", {
      toolCall: safeToolCallMetadataText(originalText),
      toolName: tc.toolName,
      toolCallId: generateToolCallId(),
      dropReason: "malformed-tool-call-body",
      cause: safeYamlFailureCause(result.failure, originalText),
    });
    if (!toolCallTextHasPrototypeSensitiveKey(originalText)) {
      processedElements.push({ type: "text", text: originalText });
    }
  }

  return tc.endIndex;
}

export const yamlXmlProtocol = (
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- reserved for future extensibility
  _protocolOptions?: YamlXmlProtocolOptions
): TCMCoreProtocol => ({
  formatTools({ tools, toolSystemPromptTemplate }) {
    return formatToolsWithPromptTemplate({ tools, toolSystemPromptTemplate });
  },

  formatToolCall(toolCall: LanguageModelV4ToolCall): string {
    let args: Record<string, unknown> = {};
    if (toolCall.input != null) {
      try {
        args = JSON.parse(toolCall.input) as Record<string, unknown>;
      } catch {
        args = { value: toolCall.input };
      }
    }
    const yamlContent = YAML.stringify(args);
    return `<${toolCall.toolName}>\n${yamlContent}</${toolCall.toolName}>`;
  },

  parseGeneratedText({ text, tools, options }) {
    const toolNames = extractToolNames(tools);
    if (toolNames.length === 0) {
      return [{ type: "text", text }];
    }

    const processedElements: LanguageModelV4Content[] = [];
    let currentIndex = 0;
    let parseText = text;

    let toolCalls = findToolCalls(parseText, toolNames);
    if (toolCalls.length === 0) {
      const repaired = tryRepairXmlSelfClosingRootWithBody(
        parseText,
        toolNames
      );
      if (repaired) {
        const repairedCalls = findToolCalls(repaired, toolNames);
        if (repairedCalls.length > 0) {
          parseText = repaired;
          toolCalls = repairedCalls;
        }
      }
    }

    for (const tc of toolCalls) {
      currentIndex = processToolCallMatch(
        parseText,
        tc,
        currentIndex,
        processedElements,
        tools,
        options
      );
    }

    if (currentIndex < parseText.length) {
      addTextOrForeignToolCalls(
        parseText.slice(currentIndex),
        processedElements,
        tools
      );
    }

    return processedElements;
  },

  createStreamParser({ tools, options }) {
    const toolNames = extractToolNames(tools);

    let buffer = "";
    let currentToolCall: {
      name: string;
      toolCallId: string;
      emittedInput: string;
      hasEmittedStart: boolean;
      pendingToolInputParts: LanguageModelV4StreamPart[];
    } | null = null;
    let currentTextId: string | null = null;
    let hasEmittedTextStart = false;

    const flushText = createFlushTextHandler(
      () => currentTextId,
      (newId: string | null) => {
        currentTextId = newId;
      },
      () => hasEmittedTextStart,
      (value: boolean) => {
        hasEmittedTextStart = value;
      }
    );

    const emitToolInputProgress = (
      _controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
      toolContent: string
    ) => {
      if (!currentToolCall) {
        return;
      }
      if (YAML_BLOCK_SCALAR_HEADER_RE.test(toolContent)) {
        return;
      }
      const toolCall = currentToolCall;
      const parsedArgs = parseYamlContentForStreamProgress(toolContent);
      if (parsedArgs === null) {
        return;
      }
      let fullInput: string;
      try {
        fullInput = stringifyToolInputWithSchema({
          toolName: toolCall.name,
          args: parsedArgs,
          tools,
        });
      } catch {
        return;
      }
      if (fullInput === "{}" && toolContent.trim().length === 0) {
        return;
      }
      emitBufferedToolInputProgressDelta({
        enqueue: (part) => {
          toolCall.pendingToolInputParts.push(part);
        },
        id: toolCall.toolCallId,
        state: toolCall,
        fullInput,
      });
    };

    const processToolCallEnd = (
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
      toolContent: string,
      toolName: string,
      toolCallId: string
    ) => {
      const result = parseYamlContent(
        toolContent,
        buildSchemaPropNameSet(toolName, tools)
      );
      flushText(controller);
      if (result.ok) {
        let finalInput: string;
        try {
          finalInput = stringifyToolInputWithSchema({
            toolName,
            args: result.value,
            tools,
          });
        } catch (error) {
          const original = `<${toolName}>${toolContent}</${toolName}>`;
          const emitRawFallback = shouldEmitRawToolCallTextOnError(options);
          emitFailedBufferedToolInputLifecycle({
            bufferedParts: currentToolCall?.pendingToolInputParts ?? [],
            controller,
            id: toolCallId,
            emitRawToolCallTextOnError: emitRawFallback,
            endInputOnError: currentToolCall?.hasEmittedStart === true,
            hideBufferedInputOnError:
              isPrototypeSensitiveToolCallInputError(error),
            rawToolCallText: original,
            emitRawText: (rawText) => {
              flushText(controller, rawText);
            },
          });
          options?.onError?.("Could not parse streaming YAML tool call", {
            toolCall: safeToolCallMetadataText(original),
            toolName,
            toolCallId,
            dropReason: "malformed-tool-call-body",
            error: safeToolCallMetadataError(error, original),
          });
          return;
        }
        if (currentToolCall && currentToolCall.toolCallId === toolCallId) {
          emitFinalizedBufferedToolInputLifecycle({
            bufferedParts: currentToolCall.pendingToolInputParts,
            controller,
            id: toolCallId,
            state: currentToolCall,
            toolName,
            finalInput,
            onMismatch: options?.onError,
          });
        } else {
          enqueueToolInputEndAndCall({
            controller,
            id: toolCallId,
            toolName,
            input: finalInput,
          });
        }
      } else {
        const original = `<${toolName}>${toolContent}</${toolName}>`;
        const emitRawFallback = shouldEmitRawToolCallTextOnError(options);
        emitFailedBufferedToolInputLifecycle({
          bufferedParts: currentToolCall?.pendingToolInputParts ?? [],
          controller,
          id: toolCallId,
          emitRawToolCallTextOnError: emitRawFallback,
          endInputOnError: currentToolCall?.hasEmittedStart === true,
          rawToolCallText: original,
          emitRawText: (rawText) => {
            flushText(controller, rawText);
          },
        });
        options?.onError?.("Could not parse streaming YAML tool call", {
          toolCall: safeToolCallMetadataText(original),
          toolName,
          toolCallId,
          dropReason: "malformed-tool-call-body",
          cause: safeYamlFailureCause(result.failure, original),
        });
      }
    };

    const finalizeUnclosedToolCall = (
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
    ) => {
      if (!currentToolCall) {
        return;
      }

      emitToolInputProgress(controller, buffer);
      const { name: toolName, toolCallId } = currentToolCall;
      const reconciledBuffer = stripTrailingPartialCloseTag(buffer, toolName);
      const result = parseYamlContent(
        reconciledBuffer,
        buildSchemaPropNameSet(toolName, tools)
      );
      flushText(controller);
      if (result.ok) {
        let finalInput: string;
        try {
          finalInput = stringifyToolInputWithSchema({
            toolName,
            args: result.value,
            tools,
          });
        } catch (error) {
          const unfinishedContent = `<${toolName}>${buffer}`;
          const emitRawFallback = shouldEmitRawToolCallTextOnError(options);
          emitFailedBufferedToolInputLifecycle({
            bufferedParts: currentToolCall.pendingToolInputParts,
            controller,
            id: toolCallId,
            emitRawToolCallTextOnError: emitRawFallback,
            endInputOnError: currentToolCall.hasEmittedStart,
            hideBufferedInputOnError:
              isPrototypeSensitiveToolCallInputError(error),
            rawToolCallText: unfinishedContent,
            emitRawText: (rawText) => {
              flushText(controller, rawText);
            },
          });
          options?.onError?.(
            "Could not complete streaming YAML tool call at finish.",
            {
              toolCall: safeToolCallMetadataText(unfinishedContent),
              toolCallId,
              toolName,
              dropReason: "malformed-tool-call-body",
              error: safeToolCallMetadataError(error, unfinishedContent),
            }
          );
          buffer = "";
          currentToolCall = null;
          return;
        }
        emitFinalizedBufferedToolInputLifecycle({
          bufferedParts: currentToolCall.pendingToolInputParts,
          controller,
          id: toolCallId,
          state: currentToolCall,
          toolName,
          finalInput,
          onMismatch: options?.onError,
        });
      } else {
        const unfinishedContent = `<${toolName}>${buffer}`;
        const emitRawFallback = shouldEmitRawToolCallTextOnError(options);
        emitFailedBufferedToolInputLifecycle({
          bufferedParts: currentToolCall.pendingToolInputParts,
          controller,
          id: toolCallId,
          emitRawToolCallTextOnError: emitRawFallback,
          endInputOnError: currentToolCall.hasEmittedStart,
          rawToolCallText: unfinishedContent,
          emitRawText: (rawText) => {
            flushText(controller, rawText);
          },
        });
        options?.onError?.(
          "Could not complete streaming YAML tool call at finish.",
          {
            toolCall: safeToolCallMetadataText(unfinishedContent),
            toolCallId,
            toolName,
            dropReason: "unfinished-tool-call",
            cause: safeYamlFailureCause(result.failure, unfinishedContent),
          }
        );
      }

      buffer = "";
      currentToolCall = null;
    };

    const handlePendingToolCall = (
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
      endTag: string,
      toolName: string
    ): boolean => {
      const endIdx = buffer.indexOf(endTag);
      if (endIdx === -1) {
        emitToolInputProgress(controller, buffer);
        return false;
      }

      const content = buffer.slice(0, endIdx);
      emitToolInputProgress(controller, content);
      buffer = buffer.slice(endIdx + endTag.length);
      processToolCallEnd(
        controller,
        content,
        toolName,
        currentToolCall?.toolCallId ?? generateToolCallId()
      );
      currentToolCall = null;
      return true;
    };

    const flushSafeText = (
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
    ): void => {
      if (buffer.length === 0) {
        return;
      }
      // Hold back only a genuine partial tool-tag suffix or a pending foreign
      // <tool_call block; everything else is provably plain text and streams
      // out immediately.
      const holds = [
        findPotentialPartialToolTagStart(buffer, toolNames),
        findForeignBlockHoldStart(buffer),
      ].filter((value): value is number => value != null);
      const holdFrom = holds.length > 0 ? Math.min(...holds) : null;
      if (holdFrom == null) {
        flushText(controller, buffer);
        buffer = "";
        return;
      }
      if (holdFrom > 0) {
        flushText(controller, buffer.slice(0, holdFrom));
        buffer = buffer.slice(holdFrom);
      }
    };

    const emitSalvagedForeignCalls = (
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
      calls: ForeignToolCallPart[]
    ): void => {
      flushText(controller);
      for (const call of calls) {
        controller.enqueue({
          type: "tool-input-start",
          id: call.toolCallId,
          toolName: call.toolName,
        });
        if (call.input.length > 0) {
          controller.enqueue({
            type: "tool-input-delta",
            id: call.toolCallId,
            delta: call.input,
          });
        }
        enqueueToolInputEndAndCall({
          controller,
          id: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
        });
      }
    };

    const flushTextBefore = (
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
      end: number
    ): void => {
      if (end > 0) {
        flushText(controller, buffer.slice(0, end));
      }
    };

    const consumeSensitiveForeignBlock = (
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
      block: string,
      start: number,
      end?: number
    ): boolean => {
      if (!toolCallTextHasPrototypeSensitiveKey(block)) {
        return false;
      }
      flushTextBefore(controller, start);
      buffer = end === undefined ? "" : buffer.slice(end);
      return true;
    };

    /**
     * Consumes a complete foreign `<tool_call>…</tool_call>` block from the
     * buffer, emitting salvaged calls (or flushing the block as text when the
     * shared JSON recovery declines). Returns false when the buffer holds no
     * complete foreign block to consume.
     */
    const tryConsumeForeignToolCallBlock = (
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
    ): boolean => {
      const lower = buffer.toLowerCase();
      const start = findForeignToolCallOpenStart(lower);
      if (start === -1) {
        return false;
      }
      const { index: realTagIndex } = findEarliestToolTag(buffer, toolNames);
      if (realTagIndex !== -1 && realTagIndex < start) {
        return false;
      }
      const closeMatch = FOREIGN_TOOL_CALL_CLOSE_RE.exec(lower.slice(start));
      if (!closeMatch) {
        return false;
      }
      const end = start + closeMatch.index + closeMatch[0].length;
      const block = buffer.slice(start, end);
      const calls = recoverGatedForeignCalls(block, tools);
      if (calls) {
        flushTextBefore(controller, start);
        emitSalvagedForeignCalls(controller, calls);
        buffer = buffer.slice(end);
        return true;
      }
      // A real tool tag inside the wrapper means the block is YAML-XML with a
      // stray wrapper; leave it to the normal tag path.
      if (findEarliestToolTag(block.slice(1), toolNames).index !== -1) {
        return false;
      }
      if (consumeSensitiveForeignBlock(controller, block, start, end)) {
        return true;
      }
      flushText(controller, buffer.slice(0, end));
      buffer = buffer.slice(end);
      return true;
    };

    /**
     * Finish-time variant: the stream ended with an unclosed foreign block
     * still buffered. Salvage it or flush it as text.
     */
    const salvageForeignBlockAtFinish = (
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
    ): void => {
      if (!buffer) {
        return;
      }
      const lower = buffer.toLowerCase();
      const start = findForeignToolCallOpenStart(lower);
      if (start === -1) {
        flushText(controller, buffer);
        buffer = "";
        return;
      }
      const block = buffer.slice(start);
      const calls = recoverGatedForeignCalls(block, tools);
      if (!calls) {
        if (consumeSensitiveForeignBlock(controller, block, start)) {
          return;
        }
        flushText(controller, buffer);
        buffer = "";
        return;
      }
      flushTextBefore(controller, start);
      emitSalvagedForeignCalls(controller, calls);
      buffer = "";
    };

    const handleNewToolTag = (
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
      tagIndex: number,
      tagName: string,
      selfClosing: boolean,
      tagLength: number
    ): void => {
      if (tagIndex > 0) {
        flushText(controller, buffer.slice(0, tagIndex));
      }

      flushText(controller);

      if (selfClosing) {
        buffer = buffer.slice(tagIndex + tagLength);
        const toolCallId = generateToolCallId();
        currentToolCall = {
          name: tagName,
          toolCallId,
          emittedInput: "",
          hasEmittedStart: true,
          pendingToolInputParts: [],
        };
        controller.enqueue({
          type: "tool-input-start",
          id: toolCallId,
          toolName: tagName,
        });
        processToolCallEnd(controller, "", tagName, toolCallId);
        currentToolCall = null;
      } else {
        const startTag = `<${tagName}>`;
        buffer = buffer.slice(tagIndex + startTag.length);
        currentToolCall = {
          name: tagName,
          toolCallId: generateToolCallId(),
          emittedInput: "",
          hasEmittedStart: true,
          pendingToolInputParts: [],
        };
        controller.enqueue({
          type: "tool-input-start",
          id: currentToolCall.toolCallId,
          toolName: tagName,
        });
      }
    };

    /** Returns false when the buffer is exhausted and scanning should stop. */
    const processIdleBuffer = (
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
    ): boolean => {
      if (tryConsumeForeignToolCallBlock(controller)) {
        return true;
      }

      const { index, name, selfClosing, tagLength } = findEarliestToolTag(
        buffer,
        toolNames
      );

      if (index === -1) {
        flushSafeText(controller);
        return false;
      }

      handleNewToolTag(controller, index, name, selfClosing, tagLength);
      return true;
    };

    const processBuffer = (
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
    ) => {
      while (true) {
        if (currentToolCall) {
          const toolName = currentToolCall.name;
          const endTag = `</${toolName}>`;
          if (!handlePendingToolCall(controller, endTag, toolName)) {
            break;
          }
        } else if (!processIdleBuffer(controller)) {
          break;
        }
      }
    };

    const handleFinishChunk = (
      controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
    ) => {
      if (currentToolCall) {
        finalizeUnclosedToolCall(controller);
      } else if (buffer) {
        salvageForeignBlockAtFinish(controller);
      }
      flushText(controller);
    };

    return new TransformStream({
      transform(chunk, controller) {
        if (chunk.type === "finish") {
          handleFinishChunk(controller);
          controller.enqueue(chunk);
          return;
        }

        // The parser re-segments text under its own synthetic ids (tool-call
        // markup is excised), so the provider's original text-start/text-end
        // envelopes are dropped instead of producing empty duplicate blocks.
        if (chunk.type === "text-start" || chunk.type === "text-end") {
          return;
        }

        // Raw provider chunks are observational side-channel events. With
        // `includeRawChunks`, providers commonly interleave one before every
        // semantic text-delta. Do not let those events force a buffered
        // partial tag (for example `<write` + `_file>`) out as plain text.
        if (chunk.type === "raw") {
          controller.enqueue(chunk);
          return;
        }

        if (chunk.type !== "text-delta") {
          if (!currentToolCall && buffer) {
            flushText(controller, buffer);
            buffer = "";
          }
          controller.enqueue(chunk);
          return;
        }

        const textContent =
          (chunk as unknown as { delta?: string }).delta ?? "";
        buffer += textContent;
        processBuffer(controller);
      },
      flush(controller) {
        if (currentToolCall) {
          finalizeUnclosedToolCall(controller);
        } else if (buffer) {
          salvageForeignBlockAtFinish(controller);
        }
        if (currentTextId && hasEmittedTextStart) {
          controller.enqueue({
            type: "text-end",
            id: currentTextId,
          });
          hasEmittedTextStart = false;
          currentTextId = null;
        }
      },
    });
  },

  extractToolCallSegments({ text, tools }) {
    const toolNames = tools.map((t) => t.name).filter(Boolean) as string[];
    if (toolNames.length === 0) {
      return [];
    }

    return findToolCalls(text, toolNames).map(
      (tc) => `<${tc.toolName}>${tc.content}</${tc.toolName}>`
    );
  },
});
