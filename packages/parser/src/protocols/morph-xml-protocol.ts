import type {
  LanguageModelV3Content,
  LanguageModelV3FunctionTool,
  LanguageModelV3ToolCall,
  LanguageModelV3ToolResultPart,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";
import {
  extractRawInner,
  parse,
  RXMLCoercionError,
  RXMLDuplicateStringTagError,
  RXMLParseError,
  stringify,
  unwrapJsonSchema,
} from "@ai-sdk-tool/rxml";
import {
  applyHeuristicPipeline as _applyHeuristicPipeline,
  createIntermediateCall as _createIntermediateCall,
  defaultPipelineConfig as _defaultPipelineConfig,
  mergePipelineConfigs as _mergePipelineConfigs,
  type PipelineConfig as _PipelineConfig,
  type ToolCallHeuristic as _ToolCallHeuristic,
  balanceTags,
  dedupeSingleTag,
  escapeInvalidLt,
  getStringPropertyNames,
  repairParsedAgainstSchema,
  shouldDeduplicateStringTags,
} from "../heuristics";
import { hasInputProperty } from "../utils/type-guards";
import type { ToolCallProtocol } from "./tool-call-protocol";

const defaultPipelineConfig = _defaultPipelineConfig;
const applyHeuristicPipeline = _applyHeuristicPipeline;
const createIntermediateCall = _createIntermediateCall;
const mergePipelineConfigs = _mergePipelineConfigs;
type PipelineConfig = _PipelineConfig;
type ToolCallHeuristic = _ToolCallHeuristic;

export interface MorphXmlProtocolOptions {
  heuristics?: ToolCallHeuristic[];
  pipeline?: PipelineConfig;
  maxReparses?: number;
}

const WHITESPACE_REGEX = /\s/;
const MALFORMED_CLOSE_RE = /<\/\s+([A-Za-z0-9_:-]+)\s*>/;
const MALFORMED_CLOSE_RE_G = /<\/\s+([A-Za-z0-9_:-]+)\s*>/g;
const NAME_CHAR_RE = /[A-Za-z0-9_:-]/;

function normalizeCloseTags(xml: string): string {
  return xml.replace(MALFORMED_CLOSE_RE_G, "</$1>");
}

function tryParseSecondaryXml(
  content: string,
  toolSchema: unknown,
  options:
    | {
        onError?: (message: string, metadata?: Record<string, unknown>) => void;
      }
    | undefined
): unknown | null {
  const normalized = normalizeCloseTags(content);
  const balanced = balanceTags(content);
  const hasMalformedClose = MALFORMED_CLOSE_RE.test(content);
  if (!hasMalformedClose && balanced.length > normalized.length) {
    return null;
  }
  try {
    let parsed: unknown = parse(balanced, toolSchema, {
      onError: options?.onError,
      noChildNodes: [],
    });
    parsed = repairParsedAgainstSchema(parsed, toolSchema);
    return parsed;
  } catch {
    if (shouldDeduplicateStringTags(toolSchema)) {
      const deduped = dedupeStringTagsAgainstSchema(balanced, toolSchema);
      if (deduped !== balanced) {
        try {
          let reparsed: unknown = parse(deduped, toolSchema, {
            onError: options?.onError,
            noChildNodes: [],
          });
          reparsed = repairParsedAgainstSchema(reparsed, toolSchema);
          return reparsed;
        } catch {
          return null;
        }
      }
    }
    return null;
  }
}

function dedupeStringTagsAgainstSchema(xml: string, schema: unknown): string {
  const names = getStringPropertyNames(schema);
  let out = xml;
  for (const key of names) {
    out = dedupeSingleTag(out, key);
  }
  return out;
}

function processTextBeforeToolCall(
  text: string,
  currentIndex: number,
  toolCallStartIndex: number,
  processedElements: LanguageModelV3Content[]
): number {
  if (toolCallStartIndex > currentIndex) {
    const textSegment = text.substring(currentIndex, toolCallStartIndex);
    if (textSegment.trim()) {
      processedElements.push({ type: "text", text: textSegment });
    }
  }
  return currentIndex;
}

interface ToolCallInfo {
  toolName: string;
  content: string;
  startIndex: number;
  endIndex: number;
}

interface ProcessToolCallParams {
  toolCall: ToolCallInfo;
  tools: LanguageModelV3FunctionTool[];
  options:
    | {
        onError?: (message: string, metadata?: Record<string, unknown>) => void;
      }
    | undefined;
  text: string;
  processedElements: LanguageModelV3Content[];
  pipelineConfig?: PipelineConfig;
  maxReparses?: number;
}

function processToolCallWithPipeline(params: ProcessToolCallParams): void {
  const {
    toolCall,
    tools,
    options,
    text,
    processedElements,
    pipelineConfig = defaultPipelineConfig,
    maxReparses,
  } = params;
  const toolSchema = getToolSchema(tools, toolCall.toolName);

  const ctx = createIntermediateCall(
    toolCall.toolName,
    toolCall.content,
    toolSchema
  );

  const result = applyHeuristicPipeline(ctx, pipelineConfig, {
    parse: (xml, schema) =>
      parse(xml, schema, { onError: options?.onError, noChildNodes: [] }),
    onError: options?.onError,
    maxReparses,
  });

  if (result.parsed !== null) {
    processedElements.push({
      type: "tool-call",
      toolCallId: generateId(),
      toolName: toolCall.toolName,
      input: JSON.stringify(result.parsed),
    });
  } else {
    const originalCallText = text.substring(
      toolCall.startIndex,
      toolCall.endIndex
    );
    const message = `Could not process XML tool call, keeping original text: ${originalCallText}`;
    options?.onError?.(message, {
      toolCall: originalCallText,
      toolName: toolCall.toolName,
      error: result.errors[0],
    });
    processedElements.push({ type: "text", text: originalCallText });
  }
}

function processToolCall(params: ProcessToolCallParams): void {
  const { toolCall, tools, options, text, processedElements } = params;
  const toolSchema = getToolSchema(tools, toolCall.toolName);
  try {
    const primary = escapeInvalidLt(normalizeCloseTags(toolCall.content));
    let parsed: unknown = parse(primary, toolSchema, {
      onError: options?.onError,
      noChildNodes: [],
    });
    parsed = repairParsedAgainstSchema(parsed, toolSchema);
    processedElements.push({
      type: "tool-call",
      toolCallId: generateId(),
      toolName: toolCall.toolName,
      input: JSON.stringify(parsed),
    });
  } catch (error) {
    const reparsed = tryParseSecondaryXml(
      toolCall.content,
      toolSchema,
      options
    );
    if (reparsed !== null) {
      processedElements.push({
        type: "tool-call",
        toolCallId: generateId(),
        toolName: toolCall.toolName,
        input: JSON.stringify(reparsed),
      });
      return;
    }
    const originalCallText = text.substring(
      toolCall.startIndex,
      toolCall.endIndex
    );
    const message = `Could not process XML tool call, keeping original text: ${originalCallText}`;
    options?.onError?.(message, {
      toolCall: originalCallText,
      toolName: toolCall.toolName,
      error,
    });
    processedElements.push({ type: "text", text: originalCallText });
  }
}

function addRemainingText(
  text: string,
  currentIndex: number,
  processedElements: LanguageModelV3Content[]
): void {
  if (currentIndex < text.length) {
    const remainingText = text.substring(currentIndex);
    if (remainingText.trim()) {
      processedElements.push({ type: "text", text: remainingText });
    }
  }
}

interface StreamingToolCallEndParams {
  toolContent: string;
  currentToolCall: { name: string; content: string };
  tools: LanguageModelV3FunctionTool[];
  options:
    | {
        onError?: (message: string, metadata?: Record<string, unknown>) => void;
      }
    | undefined;
  ctrl: TransformStreamDefaultController;
  flushText: (ctrl: TransformStreamDefaultController, text?: string) => void;
  pipelineConfig?: PipelineConfig;
  maxReparses?: number;
}

function handleStreamingToolCallEndWithPipeline(
  params: StreamingToolCallEndParams
): void {
  const {
    toolContent,
    currentToolCall,
    tools,
    options,
    ctrl,
    flushText,
    pipelineConfig = defaultPipelineConfig,
    maxReparses,
  } = params;
  const toolSchema = getToolSchema(tools, currentToolCall.name);

  const ctx = createIntermediateCall(
    currentToolCall.name,
    toolContent,
    toolSchema
  );

  const result = applyHeuristicPipeline(ctx, pipelineConfig, {
    parse: (xml, schema) =>
      parse(xml, schema, { onError: options?.onError, noChildNodes: [] }),
    onError: options?.onError,
    maxReparses,
  });

  flushText(ctrl);

  if (result.parsed !== null) {
    ctrl.enqueue({
      type: "tool-call",
      toolCallId: generateId(),
      toolName: currentToolCall.name,
      input: JSON.stringify(result.parsed),
    });
  } else {
    const endTag = `</${currentToolCall.name}>`;
    const originalCallText = `<${currentToolCall.name}>${toolContent}${endTag}`;
    const error = result.errors[0];
    let message =
      "Could not process streaming XML tool call; emitting original text.";

    if (error instanceof RXMLDuplicateStringTagError) {
      message = `Duplicate string tags detected in streaming tool call '${currentToolCall.name}'; emitting original text.`;
    } else if (error instanceof RXMLCoercionError) {
      message = `Failed to coerce arguments for streaming tool call '${currentToolCall.name}'; emitting original text.`;
    } else if (error instanceof RXMLParseError) {
      message = `Failed to parse XML for streaming tool call '${currentToolCall.name}'; emitting original text.`;
    }

    options?.onError?.(message, {
      toolCall: originalCallText,
      toolName: currentToolCall.name,
      error,
    });
    flushText(ctrl, originalCallText);
  }
}

function handleStreamingToolCallEnd(params: StreamingToolCallEndParams): void {
  const { toolContent, currentToolCall, tools, options, ctrl, flushText } =
    params;
  const toolSchema = getToolSchema(tools, currentToolCall.name);
  try {
    const primary = escapeInvalidLt(normalizeCloseTags(toolContent));
    let parsed: unknown = parse(primary, toolSchema, {
      onError: options?.onError,
      noChildNodes: [],
    });
    parsed = repairParsedAgainstSchema(parsed, toolSchema);

    flushText(ctrl);

    ctrl.enqueue({
      type: "tool-call",
      toolCallId: generateId(),
      toolName: currentToolCall.name,
      input: JSON.stringify(parsed),
    });
  } catch (error) {
    const parsed = tryParseSecondaryXml(toolContent, toolSchema, options);
    if (parsed !== null) {
      flushText(ctrl);
      ctrl.enqueue({
        type: "tool-call",
        toolCallId: generateId(),
        toolName: currentToolCall.name,
        input: JSON.stringify(parsed),
      });
      return;
    }
    handleStreamingToolCallError({
      error,
      currentToolCall,
      toolContent,
      options,
      ctrl,
      flushText,
    });
  }
}

interface StreamingToolCallErrorParams {
  error: unknown;
  currentToolCall: { name: string; content: string };
  toolContent: string;
  options:
    | {
        onError?: (message: string, metadata?: Record<string, unknown>) => void;
      }
    | undefined;
  ctrl: TransformStreamDefaultController;
  flushText: (ctrl: TransformStreamDefaultController, text?: string) => void;
}

function handleStreamingToolCallError(
  params: StreamingToolCallErrorParams
): void {
  const { error, currentToolCall, toolContent, options, ctrl, flushText } =
    params;
  const endTag = `</${currentToolCall.name}>`;
  const originalCallText = `<${currentToolCall.name}>${toolContent}${endTag}`;
  let message =
    "Could not process streaming XML tool call; emitting original text.";

  if (error instanceof RXMLDuplicateStringTagError) {
    message = `Duplicate string tags detected in streaming tool call '${currentToolCall.name}'; emitting original text.`;
  } else if (error instanceof RXMLCoercionError) {
    message = `Failed to coerce arguments for streaming tool call '${currentToolCall.name}'; emitting original text.`;
  } else if (error instanceof RXMLParseError) {
    message = `Failed to parse XML for streaming tool call '${currentToolCall.name}'; emitting original text.`;
  }

  options?.onError?.(message, {
    toolCall: originalCallText,
    toolName: currentToolCall.name,
    error,
  });
  flushText(ctrl, originalCallText);
}

function findEarliestToolTag(
  buffer: string,
  toolNames: string[]
): { index: number; name: string; selfClosing: boolean } {
  let bestIndex = -1;
  let bestName = "";
  let bestSelfClosing = false;

  if (toolNames.length > 0) {
    for (const name of toolNames) {
      const openTag = `<${name}>`;
      const selfTag = `<${name}/>`;
      const idxOpen = buffer.indexOf(openTag);
      const idxSelf = buffer.indexOf(selfTag);

      if (idxOpen !== -1 && (bestIndex === -1 || idxOpen < bestIndex)) {
        bestIndex = idxOpen;
        bestName = name;
        bestSelfClosing = false;
      }
      if (idxSelf !== -1 && (bestIndex === -1 || idxSelf < bestIndex)) {
        bestIndex = idxSelf;
        bestName = name;
        bestSelfClosing = true;
      }
    }
  }

  return { index: bestIndex, name: bestName, selfClosing: bestSelfClosing };
}

function handleNoToolTagInBuffer(
  buffer: string,
  maxStartTagLen: number,
  controller: TransformStreamDefaultController,
  flushText: (ctrl: TransformStreamDefaultController, text?: string) => void
): { buffer: string; shouldContinue: boolean } {
  const tail = Math.max(0, maxStartTagLen - 1);
  const safeLen = Math.max(0, buffer.length - tail);
  if (safeLen > 0) {
    const textToFlush = buffer.slice(0, safeLen);
    flushText(controller, textToFlush);
    return { buffer: buffer.slice(safeLen), shouldContinue: true };
  }
  return { buffer, shouldContinue: false };
}

interface ProcessToolCallInBufferParams {
  buffer: string;
  currentToolCall: { name: string; content: string };
  tools: LanguageModelV3FunctionTool[];
  options:
    | {
        onError?: (message: string, metadata?: Record<string, unknown>) => void;
      }
    | undefined;
  controller: TransformStreamDefaultController;
  flushText: (ctrl: TransformStreamDefaultController, text?: string) => void;
  setBuffer: (buffer: string) => void;
  pipelineConfig?: PipelineConfig;
  maxReparses?: number;
}

function processToolCallInBuffer(params: ProcessToolCallInBufferParams): {
  buffer: string;
  currentToolCall: { name: string; content: string } | null;
  shouldBreak: boolean;
} {
  const {
    buffer,
    currentToolCall,
    tools,
    options,
    controller,
    flushText,
    setBuffer,
    pipelineConfig,
    maxReparses,
  } = params;
  const endTag = `</${currentToolCall.name}>`;
  const normalized = normalizeCloseTags(buffer);
  const effectiveBuffer = normalized;
  const endTagIndex = effectiveBuffer.indexOf(endTag);

  if (endTagIndex !== -1) {
    const toolContent = effectiveBuffer.substring(0, endTagIndex);
    const newBuffer = effectiveBuffer.substring(endTagIndex + endTag.length);

    setBuffer("");

    if (pipelineConfig) {
      handleStreamingToolCallEndWithPipeline({
        toolContent,
        currentToolCall,
        tools,
        options,
        ctrl: controller,
        flushText,
        pipelineConfig,
        maxReparses,
      });
    } else {
      handleStreamingToolCallEnd({
        toolContent,
        currentToolCall,
        tools,
        options,
        ctrl: controller,
        flushText,
      });
    }

    setBuffer(newBuffer);
    return { buffer: newBuffer, currentToolCall: null, shouldBreak: false };
  }
  return { buffer: effectiveBuffer, currentToolCall, shouldBreak: true };
}

interface ProcessNoToolCallInBufferParams {
  buffer: string;
  toolNames: string[];
  maxStartTagLen: number;
  controller: TransformStreamDefaultController;
  flushText: (ctrl: TransformStreamDefaultController, text?: string) => void;
  tools: LanguageModelV3FunctionTool[];
  options:
    | {
        onError?: (message: string, metadata?: Record<string, unknown>) => void;
      }
    | undefined;
  pipelineConfig?: PipelineConfig;
  maxReparses?: number;
}

function processNoToolCallInBuffer(params: ProcessNoToolCallInBufferParams): {
  buffer: string;
  currentToolCall: { name: string; content: string } | null;
  shouldBreak: boolean;
  shouldContinue: boolean;
} {
  const {
    buffer,
    toolNames,
    maxStartTagLen,
    controller,
    flushText,
    tools,
    options,
    pipelineConfig,
    maxReparses,
  } = params;
  const {
    index: earliestStartTagIndex,
    name: earliestToolName,
    selfClosing,
  } = findEarliestToolTag(buffer, toolNames);

  if (earliestStartTagIndex !== -1) {
    const textBeforeTag = buffer.substring(0, earliestStartTagIndex);
    flushText(controller, textBeforeTag);

    if (selfClosing) {
      const selfTag = `<${earliestToolName}/>`;
      const newBuffer = buffer.substring(
        earliestStartTagIndex + selfTag.length
      );
      if (pipelineConfig) {
        handleStreamingToolCallEndWithPipeline({
          toolContent: "",
          currentToolCall: { name: earliestToolName, content: "" },
          tools,
          options,
          ctrl: controller,
          flushText,
          pipelineConfig,
          maxReparses,
        });
      } else {
        handleStreamingToolCallEnd({
          toolContent: "",
          currentToolCall: { name: earliestToolName, content: "" },
          tools,
          options,
          ctrl: controller,
          flushText,
        });
      }
      return {
        buffer: newBuffer,
        currentToolCall: null,
        shouldBreak: false,
        shouldContinue: false,
      };
    }
    const startTag = `<${earliestToolName}>`;
    const newBuffer = buffer.substring(earliestStartTagIndex + startTag.length);
    return {
      buffer: newBuffer,
      currentToolCall: { name: earliestToolName, content: "" },
      shouldBreak: false,
      shouldContinue: false,
    };
  }

  const result = handleNoToolTagInBuffer(
    buffer,
    maxStartTagLen,
    controller,
    flushText
  );
  return {
    buffer: result.buffer,
    currentToolCall: null,
    shouldBreak: !result.shouldContinue,
    shouldContinue: result.shouldContinue,
  };
}

function createFlushTextHandler(
  getBuffer: () => string,
  setBuffer: (buffer: string) => void,
  getCurrentTextId: () => string | null,
  setCurrentTextId: (id: string | null) => void
) {
  return (controller: TransformStreamDefaultController, text?: string) => {
    const content = text ?? getBuffer();
    if (content) {
      const currentTextId = getCurrentTextId();
      if (!currentTextId) {
        const newId = generateId();
        setCurrentTextId(newId);
        controller.enqueue({ type: "text-start", id: newId });
      }
      controller.enqueue({
        type: "text-delta",
        id: getCurrentTextId() as string,
        delta: content,
      });
      if (text === undefined) {
        setBuffer("");
      }
    }

    const currentTextId = getCurrentTextId();
    if (currentTextId && !text) {
      controller.enqueue({ type: "text-end", id: currentTextId });
      setCurrentTextId(null);
    }
  };
}

interface ProcessBufferHandlerParams {
  getBuffer: () => string;
  setBuffer: (buffer: string) => void;
  getCurrentToolCall: () => { name: string; content: string } | null;
  setCurrentToolCall: (
    toolCall: { name: string; content: string } | null
  ) => void;
  tools: LanguageModelV3FunctionTool[];
  options:
    | {
        onError?: (message: string, metadata?: Record<string, unknown>) => void;
      }
    | undefined;
  toolNames: string[];
  maxStartTagLen: number;
  flushText: (ctrl: TransformStreamDefaultController, text?: string) => void;
  pipelineConfig?: PipelineConfig;
  maxReparses?: number;
}

function processBufferWithToolCall(
  params: ProcessBufferHandlerParams,
  controller: TransformStreamDefaultController
): boolean {
  const {
    getBuffer,
    setBuffer,
    getCurrentToolCall,
    setCurrentToolCall,
    tools,
    options,
    flushText,
    pipelineConfig,
    maxReparses,
  } = params;
  const currentToolCall = getCurrentToolCall();

  if (!currentToolCall) {
    return true;
  }

  const result = processToolCallInBuffer({
    buffer: getBuffer(),
    currentToolCall,
    tools,
    options,
    controller,
    flushText,
    setBuffer,
    pipelineConfig,
    maxReparses,
  });
  setBuffer(result.buffer);
  setCurrentToolCall(result.currentToolCall);
  return result.shouldBreak;
}

function processBufferWithoutToolCall(
  params: ProcessBufferHandlerParams,
  controller: TransformStreamDefaultController
): { shouldBreak: boolean; shouldContinue: boolean } {
  const {
    getBuffer,
    setBuffer,
    setCurrentToolCall,
    tools,
    options,
    toolNames,
    maxStartTagLen,
    flushText,
    pipelineConfig,
    maxReparses,
  } = params;

  const result = processNoToolCallInBuffer({
    buffer: getBuffer(),
    toolNames,
    maxStartTagLen,
    controller,
    flushText,
    tools,
    options,
    pipelineConfig,
    maxReparses,
  });
  setBuffer(result.buffer);
  setCurrentToolCall(result.currentToolCall);
  return {
    shouldBreak: result.shouldBreak,
    shouldContinue: result.shouldContinue,
  };
}

function processBufferLoop(
  params: ProcessBufferHandlerParams,
  controller: TransformStreamDefaultController
): void {
  while (true) {
    const currentToolCall = params.getCurrentToolCall();
    if (currentToolCall) {
      const shouldBreak = processBufferWithToolCall(params, controller);
      if (shouldBreak) {
        break;
      }
    } else {
      const { shouldBreak, shouldContinue } = processBufferWithoutToolCall(
        params,
        controller
      );
      if (shouldContinue) {
        continue;
      }
      if (shouldBreak) {
        break;
      }
    }
  }
}

function createProcessBufferHandler(params: ProcessBufferHandlerParams) {
  return (controller: TransformStreamDefaultController) => {
    processBufferLoop(params, controller);
  };
}

interface ResolvedPipelineOptions {
  pipelineConfig: PipelineConfig | undefined;
  maxReparses: number | undefined;
}

function buildPipelineOptions(
  protocolOptions?: MorphXmlProtocolOptions
): ResolvedPipelineOptions {
  const maxReparses = protocolOptions?.maxReparses;

  if (protocolOptions?.pipeline) {
    return {
      pipelineConfig: mergePipelineConfigs(
        defaultPipelineConfig,
        protocolOptions.pipeline
      ),
      maxReparses,
    };
  }
  if (protocolOptions?.heuristics) {
    return {
      pipelineConfig: {
        ...defaultPipelineConfig,
        preParse: [
          ...(defaultPipelineConfig.preParse ?? []),
          ...protocolOptions.heuristics.filter((h) => h.phase === "pre-parse"),
        ],
        fallbackReparse: [
          ...(defaultPipelineConfig.fallbackReparse ?? []),
          ...protocolOptions.heuristics.filter(
            (h) => h.phase === "fallback-reparse"
          ),
        ],
        postParse: [
          ...(defaultPipelineConfig.postParse ?? []),
          ...protocolOptions.heuristics.filter((h) => h.phase === "post-parse"),
        ],
      },
      maxReparses,
    };
  }
  return { pipelineConfig: undefined, maxReparses };
}

export const morphXmlProtocol = (
  protocolOptions?: MorphXmlProtocolOptions
): ToolCallProtocol => {
  const { pipelineConfig, maxReparses } = buildPipelineOptions(protocolOptions);

  return {
    formatTools({ tools, toolSystemPromptTemplate }) {
      const toolsForPrompt = (tools || []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: unwrapJsonSchema(tool.inputSchema),
      }));
      return toolSystemPromptTemplate(JSON.stringify(toolsForPrompt));
    },

    formatToolCall(toolCall: LanguageModelV3ToolCall): string {
      let args: unknown = {};
      const inputValue = hasInputProperty(toolCall)
        ? toolCall.input
        : undefined;

      if (typeof inputValue === "string") {
        try {
          args = JSON.parse(inputValue);
        } catch {
          args = inputValue;
        }
      } else {
        args = inputValue;
      }
      return stringify(toolCall.toolName, args, {
        suppressEmptyNode: false,
        format: false,
      });
    },

    formatToolResponse(toolResult: LanguageModelV3ToolResultPart): string {
      return stringify("tool_response", {
        tool_name: toolResult.toolName,
        result: toolResult.output,
      });
    },

    parseGeneratedText({ text, tools, options }) {
      const toolNames = tools.map((t) => t.name).filter((name) => name != null);
      if (toolNames.length === 0) {
        return [{ type: "text", text }];
      }

      const processedElements: LanguageModelV3Content[] = [];
      let currentIndex = 0;

      const toolCallsRaw = findToolCalls(text, toolNames);
      const toolCallsNorm = collectToolCallsFromNormalizedText(text, toolNames);
      const seen = new Set<string>();
      const toolCalls = [...toolCallsRaw, ...toolCallsNorm]
        .filter((tc) => {
          const key = `${tc.toolName}:${tc.startIndex}:${tc.endIndex}`;
          if (seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        })
        .sort((a, b) => a.startIndex - b.startIndex);

      // Debug logging for model output analysis
      if (process.env.DEBUG_PARSER_OUTPUT === "true") {
        console.log("\n=== PARSER DEBUG ===");
        console.log(`Available tools: ${toolNames.join(", ")}`);
        console.log(`Full text length: ${text.length}`);
        console.log(`Full text:\n${text}\n`);
        console.log(`Tool calls found: ${toolCalls.length}`);
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i];
          console.log(`\n[Tool Call ${i + 1}] ${tc.toolName}`);
          console.log(`Position: ${tc.startIndex} - ${tc.endIndex}`);
          console.log(`Segment:\n${tc.segment}`);
          console.log(`Content:\n${tc.content}`);
        }
        console.log("===================\n");
      }

      for (const toolCall of toolCalls) {
        currentIndex = processTextBeforeToolCall(
          text,
          currentIndex,
          toolCall.startIndex,
          processedElements
        );

        if (pipelineConfig) {
          processToolCallWithPipeline({
            toolCall,
            tools,
            options,
            text,
            processedElements,
            pipelineConfig,
            maxReparses,
          });
        } else {
          processToolCall({
            toolCall,
            tools,
            options,
            text,
            processedElements,
          });
        }

        currentIndex = toolCall.endIndex;
      }

      addRemainingText(text, currentIndex, processedElements);

      return processedElements;
    },

    createStreamParser({ tools, options }) {
      const toolNames = tools.map((t) => t.name).filter((name) => name != null);
      const maxStartTagLen = toolNames.length
        ? Math.max(...toolNames.map((n) => `<${n}>`.length))
        : 0;
      let buffer = "";
      let currentToolCall: { name: string; content: string } | null = null;
      let currentTextId: string | null = null;

      const flushText = createFlushTextHandler(
        () => buffer,
        (newBuffer: string) => {
          buffer = newBuffer;
        },
        () => currentTextId,
        (newId: string | null) => {
          currentTextId = newId;
        }
      );

      const processChunk = (
        chunk: { type: string; delta?: string },
        controller: TransformStreamDefaultController
      ) => {
        if (chunk.type !== "text-delta") {
          if (buffer) {
            flushText(controller);
          }
          controller.enqueue(chunk);
          return;
        }

        buffer += chunk.delta;
        processBuffer(controller);
      };

      const processBuffer = createProcessBufferHandler({
        getBuffer: () => buffer,
        setBuffer: (newBuffer: string) => {
          buffer = newBuffer;
        },
        getCurrentToolCall: () => currentToolCall,
        setCurrentToolCall: (
          newToolCall: { name: string; content: string } | null
        ) => {
          currentToolCall = newToolCall;
        },
        tools,
        options,
        toolNames,
        maxStartTagLen,
        flushText,
        pipelineConfig,
        maxReparses,
      });

      const flushBuffer = (controller: TransformStreamDefaultController) => {
        if (currentToolCall) {
          const unfinishedCall = `<${currentToolCall.name}>${buffer}`;
          flushText(controller, unfinishedCall);
        } else if (buffer) {
          flushText(controller);
        }

        if (currentTextId) {
          controller.enqueue({ type: "text-end", id: currentTextId });
        }
      };

      return new TransformStream({
        transform(chunk, controller) {
          processChunk(chunk, controller);
        },
        flush(controller) {
          flushBuffer(controller);
        },
      });
    },

    extractToolCallSegments({ text, tools }) {
      const toolNames = tools.map((t) => t.name).filter(Boolean) as string[];
      if (toolNames.length === 0) {
        return [];
      }

      return findToolCalls(text, toolNames).map((tc) => tc.segment);
    },
  };
};

export function getToolSchema(
  tools: LanguageModelV3FunctionTool[],
  toolName: string
) {
  return tools.find((t) => t.name === toolName)?.inputSchema;
}

function findClosingTagEndFlexible(
  text: string,
  contentStart: number,
  toolName: string
): number {
  let pos = contentStart;
  let depth = 1;

  while (pos < text.length) {
    const tok = nextTagToken(text, pos);
    if (tok.kind === "eof") {
      break;
    }
    const result = updateDepthWithToken(tok, toolName, depth);
    depth = result.depth;
    if (result.closedAt !== undefined) {
      return result.closedAt;
    }
    pos = tok.nextPos;
  }

  return -1;
}

function skipSpecialSegment(text: string, lt: number): number | null {
  const next = text[lt + 1];
  if (next !== "!" && next !== "?") {
    return null;
  }
  const gt = text.indexOf(">", lt + 1);
  if (gt === -1) {
    return null;
  }
  return gt + 1;
}

function consumeClosingTag(
  text: string,
  lt: number,
  _toolName: string
): { matched: boolean; endPos: number } {
  let p = lt + 2;
  while (p < text.length && WHITESPACE_REGEX.test(text[p])) {
    p += 1;
  }
  const gt = text.indexOf(">", lt + 1);
  const endPos = gt === -1 ? text.length : gt + 1;
  return { matched: false, endPos };
}

function consumeOpenTag(
  text: string,
  lt: number
): { name: string; selfClosing: boolean; nextPos: number } | null {
  let p = lt + 1;
  while (p < text.length && WHITESPACE_REGEX.test(text[p])) {
    p += 1;
  }
  const nameStart = p;
  while (p < text.length && NAME_CHAR_RE.test(text.charAt(p))) {
    p += 1;
  }
  const name = text.slice(nameStart, p);
  const q = text.indexOf(">", p);
  if (q === -1) {
    return null;
  }
  let r = q - 1;
  while (r >= nameStart && WHITESPACE_REGEX.test(text[r])) {
    r -= 1;
  }
  const selfClosing = text[r] === "/";
  return { name, selfClosing, nextPos: q + 1 };
}

function updateDepthWithToken(
  tok:
    | { kind: "special"; nextPos: number }
    | { kind: "close"; name: string; nextPos: number }
    | { kind: "open"; name: string; selfClosing: boolean; nextPos: number },
  toolName: string,
  depth: number
): { depth: number; closedAt?: number } {
  if (tok.kind === "close" && tok.name === toolName) {
    const newDepth = depth - 1;
    return newDepth === 0
      ? { depth: newDepth, closedAt: tok.nextPos }
      : { depth: newDepth };
  }
  if (tok.kind === "open" && tok.name === toolName && !tok.selfClosing) {
    return { depth: depth + 1 };
  }
  return { depth };
}

function nextTagToken(
  text: string,
  fromPos: number
):
  | { kind: "eof"; nextPos: number }
  | { kind: "special"; nextPos: number }
  | { kind: "close"; name: string; nextPos: number }
  | { kind: "open"; name: string; selfClosing: boolean; nextPos: number } {
  const lt = text.indexOf("<", fromPos);
  if (lt === -1 || lt + 1 >= text.length) {
    return { kind: "eof", nextPos: text.length };
  }
  const next = text[lt + 1];
  const specialEnd = skipSpecialSegment(text, lt);
  if (specialEnd !== null) {
    return { kind: "special", nextPos: specialEnd };
  }
  if (next === "/") {
    const closing = consumeClosingTag(text, lt, "");
    let p = lt + 2;
    while (p < text.length && WHITESPACE_REGEX.test(text[p])) {
      p += 1;
    }
    const nameStart = p;
    while (p < text.length && NAME_CHAR_RE.test(text.charAt(p))) {
      p += 1;
    }
    const name = text.slice(nameStart, p);
    return { kind: "close", name, nextPos: closing.endPos };
  }
  const open = consumeOpenTag(text, lt);
  if (open === null) {
    return { kind: "eof", nextPos: text.length };
  }
  return {
    kind: "open",
    name: open.name,
    selfClosing: open.selfClosing,
    nextPos: open.nextPos,
  };
}

function collectToolCallsFromNormalizedText(
  text: string,
  toolNames: string[]
): Array<{
  toolName: string;
  startIndex: number;
  endIndex: number;
  content: string;
  segment: string;
}> {
  const normalizedText = normalizeCloseTags(text);
  const collected: Array<{
    toolName: string;
    startIndex: number;
    endIndex: number;
    content: string;
    segment: string;
  }> = [];
  for (const toolName of toolNames) {
    const startTag = `<${toolName}>`;
    let idx = 0;
    let lastOrigIdx = 0;
    while (idx < normalizedText.length) {
      const tagStartNorm = normalizedText.indexOf(startTag, idx);
      if (tagStartNorm === -1) {
        break;
      }
      const contentStartNorm = tagStartNorm + startTag.length;
      const endNorm = findClosingTagEndFlexible(
        normalizedText,
        contentStartNorm,
        toolName
      );
      if (endNorm > contentStartNorm) {
        const tagStartOrig = text.indexOf(startTag, lastOrigIdx);
        const contentStartOrig = tagStartOrig + startTag.length;
        let endOrig = findClosingTagEndFlexible(
          text,
          contentStartOrig,
          toolName
        );
        if (endOrig === -1) {
          const approxLen = endNorm - tagStartNorm;
          endOrig = Math.min(text.length, tagStartOrig + approxLen);
        }
        const segment = text.substring(tagStartOrig, endOrig);
        const inner =
          extractRawInner(segment, toolName) ??
          segment.substring(startTag.length, segment.lastIndexOf("<"));
        collected.push({
          toolName,
          startIndex: tagStartOrig,
          endIndex: endOrig,
          content: inner,
          segment,
        });
        lastOrigIdx = endOrig;
        idx = endNorm;
      } else {
        idx = contentStartNorm;
      }
    }
  }
  return collected.sort((a, b) => a.startIndex - b.startIndex);
}

function getNextTagInfo(
  text: string,
  toolName: string,
  fromIndex: number
): {
  found: boolean;
  tagStart: number;
  selfClosing: boolean;
  startTag: string;
  selfTag: string;
} {
  const startTag = `<${toolName}>`;
  const selfTag = `<${toolName}/>`;
  const openIdx = text.indexOf(startTag, fromIndex);
  const selfIdx = text.indexOf(selfTag, fromIndex);
  const hasOpen = openIdx !== -1;
  const hasSelf = selfIdx !== -1;
  if (!(hasOpen || hasSelf)) {
    return {
      found: false,
      tagStart: -1,
      selfClosing: false,
      startTag,
      selfTag,
    };
  }
  const pickSelf = hasSelf && (!hasOpen || selfIdx < openIdx);
  const tagStart = pickSelf ? selfIdx : openIdx;
  return { found: true, tagStart, selfClosing: pickSelf, startTag, selfTag };
}

function findToolCallsForName(
  text: string,
  toolName: string
): Array<{
  toolName: string;
  startIndex: number;
  endIndex: number;
  content: string;
  segment: string;
}> {
  const toolCalls: Array<{
    toolName: string;
    startIndex: number;
    endIndex: number;
    content: string;
    segment: string;
  }> = [];
  let searchIndex = 0;

  while (searchIndex < text.length) {
    const info = getNextTagInfo(text, toolName, searchIndex);
    if (!info.found) {
      break;
    }

    const { tagStart, selfClosing, startTag, selfTag } = info;

    if (selfClosing) {
      const endIndex = tagStart + selfTag.length;
      const segment = text.substring(tagStart, endIndex);
      toolCalls.push({
        toolName,
        startIndex: tagStart,
        endIndex,
        content: "",
        segment,
      });
      searchIndex = endIndex;
      continue;
    }

    const contentStart = tagStart + startTag.length;
    const fullTagEnd = findClosingTagEndFlexible(text, contentStart, toolName);
    if (fullTagEnd !== -1 && fullTagEnd > contentStart) {
      const segment = text.substring(tagStart, fullTagEnd);
      const inner =
        extractRawInner(segment, toolName) ??
        segment.substring(startTag.length, segment.lastIndexOf("<"));
      toolCalls.push({
        toolName,
        startIndex: tagStart,
        endIndex: fullTagEnd,
        content: inner,
        segment,
      });
      searchIndex = fullTagEnd;
    } else {
      searchIndex = contentStart;
    }
  }

  return toolCalls;
}

function findToolCalls(
  text: string,
  toolNames: string[]
): Array<{
  toolName: string;
  startIndex: number;
  endIndex: number;
  content: string;
  segment: string;
}> {
  const toolCalls: Array<{
    toolName: string;
    startIndex: number;
    endIndex: number;
    content: string;
    segment: string;
  }> = [];

  for (const toolName of toolNames) {
    const calls = findToolCallsForName(text, toolName);
    toolCalls.push(...calls);
  }

  return toolCalls.sort((a, b) => a.startIndex - b.startIndex);
}

export {
  defaultPipelineConfig,
  applyHeuristicPipeline,
  createIntermediateCall,
  mergePipelineConfigs,
};
export type { PipelineConfig, ToolCallHeuristic };
