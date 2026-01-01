import {
  extractRawInner,
  parse,
  stringify,
  unwrapJsonSchema,
} from "@ai-sdk-tool/rxml";
import {
  applyHeuristicPipeline,
  balanceTags,
  createIntermediateCall,
  dedupeSingleTag,
  defaultPipelineConfig,
  escapeInvalidLt,
  getStringPropertyNames,
  type PipelineConfig,
  repairParsedAgainstSchema,
  shouldDeduplicateStringTags,
  type ToolCallHeuristic,
} from "../heuristics";
import type { CoreContentPart, CoreFunctionTool } from "../types";
import { generateId } from "../utils/id";
import type { ToolCallProtocol } from "./tool-call-protocol";

export interface MorphXmlProtocolOptions {
  heuristics?: ToolCallHeuristic[];
  pipeline?: PipelineConfig;
  maxReparses?: number;
}
const NAME_CHAR_RE = /[A-Za-z0-9_:-]/;

function getToolSchema(tools: CoreFunctionTool[], toolName: string) {
  return tools.find((t) => t.name === toolName)?.inputSchema;
}
function tryParseSecondaryXml(
  content: string,
  toolSchema: unknown,
  options: any
): unknown | null {
  const balanced = balanceTags(content);
  try {
    let parsed: unknown = parse(balanced, toolSchema, {
      onError: options?.onError,
      noChildNodes: [],
    });
    parsed = repairParsedAgainstSchema(parsed, toolSchema);
    return parsed;
  } catch {
    if (shouldDeduplicateStringTags(toolSchema)) {
      const names = getStringPropertyNames(toolSchema);
      let deduped = balanced;
      for (const key of names) deduped = dedupeSingleTag(deduped, key);
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

function processToolCallWithPipeline(params: any): void {
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
    parse: (xml: string, schema: unknown) =>
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
    options?.onError?.(
      `Could not process XML tool call: ${toolCall.toolName}`,
      { toolCall: toolCall.content }
    );
    processedElements.push({
      type: "text",
      text: text.substring(toolCall.startIndex, toolCall.endIndex),
    });
  }
}

function handleStreamingToolCallEnd(params: any): void {
  const {
    toolContent,
    currentToolCall,
    tools,
    options,
    ctrl,
    flushText,
    pipelineConfig,
    maxReparses,
  } = params;
  const toolSchema = getToolSchema(tools, currentToolCall.name);
  let result: any = { parsed: null };
  if (pipelineConfig) {
    const ctx = createIntermediateCall(
      currentToolCall.name,
      toolContent,
      toolSchema
    );
    result = applyHeuristicPipeline(ctx, pipelineConfig, {
      parse: (xml: string, schema: unknown) =>
        parse(xml, schema, { onError: options?.onError, noChildNodes: [] }),
      onError: options?.onError,
      maxReparses,
    });
  } else {
    try {
      const primary = escapeInvalidLt(toolContent);
      const parsed: unknown = parse(primary, toolSchema, {
        onError: options?.onError,
        noChildNodes: [],
      });
      result.parsed = repairParsedAgainstSchema(parsed, toolSchema);
    } catch {
      result.parsed = tryParseSecondaryXml(toolContent, toolSchema, options);
    }
  }
  flushText(ctrl);
  if (result.parsed !== null) {
    ctrl.enqueue({
      type: "tool-call",
      toolCallId: generateId(),
      toolName: currentToolCall.name,
      input: JSON.stringify(result.parsed),
    });
  } else {
    const original = `<${currentToolCall.name}>${toolContent}</${currentToolCall.name}>`;
    options?.onError?.("Could not process streaming XML tool call", {
      toolCall: original,
    });
    flushText(ctrl, original);
  }
}

export const morphXmlProtocol = (
  protocolOptions?: MorphXmlProtocolOptions
): ToolCallProtocol => {
  const pipelineConfig = protocolOptions?.pipeline;
  const maxReparses = protocolOptions?.maxReparses;
  return {
    formatTools({ tools, toolSystemPromptTemplate }) {
      const toolsForPrompt = (tools || []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: unwrapJsonSchema(tool.inputSchema),
      }));
      return toolSystemPromptTemplate(JSON.stringify(toolsForPrompt));
    },
    formatToolCall(toolCall) {
      let args: unknown = {};
      try {
        args = JSON.parse(toolCall.input);
      } catch {
        args = toolCall.input;
      }
      return stringify(toolCall.toolName, args, {
        suppressEmptyNode: false,
        format: false,
      });
    },
    formatToolResponse(toolResult) {
      return stringify("tool_response", {
        tool_name: toolResult.toolName,
        result: toolResult.result,
      });
    },
    parseGeneratedText({ text, tools, options }) {
      const toolNames = tools.map((t) => t.name).filter(Boolean) as string[];
      if (toolNames.length === 0) return [{ type: "text", text }];
      const processedElements: CoreContentPart[] = [];
      let currentIndex = 0;
      // Simple tag finder
      const toolCalls: any[] = [];
      for (const name of toolNames) {
        let pos = 0;
        while ((pos = text.indexOf(`<${name}`, pos)) !== -1) {
          const endIdx = text.indexOf(`</${name}>`, pos);
          if (endIdx !== -1) {
            const segment = text.substring(pos, endIdx + name.length + 3);
            const content = extractRawInner(segment, name) || "";
            toolCalls.push({
              toolName: name,
              startIndex: pos,
              endIndex: endIdx + name.length + 3,
              content,
              segment,
            });
            pos = endIdx + name.length + 3;
          } else if (
            text.substring(pos, pos + name.length + 3) === `<${name}/>`
          ) {
            const len = name.length + 3;
            toolCalls.push({
              toolName: name,
              startIndex: pos,
              endIndex: pos + len,
              content: "",
              segment: text.substring(pos, pos + len),
            });
            pos += len;
          } else {
            pos += 1;
          }
        }
      }
      toolCalls.sort((a, b) => a.startIndex - b.startIndex);
      for (const tc of toolCalls) {
        if (tc.startIndex > currentIndex) {
          processedElements.push({
            type: "text",
            text: text.substring(currentIndex, tc.startIndex),
          });
        }
        processToolCallWithPipeline({
          toolCall: tc,
          tools,
          options,
          text,
          processedElements,
          pipelineConfig,
          maxReparses,
        });
        currentIndex = tc.endIndex;
      }
      if (currentIndex < text.length)
        processedElements.push({
          type: "text",
          text: text.substring(currentIndex),
        });
      return processedElements;
    },
    createStreamParser({ tools, options }) {
      const toolNames = tools.map((t) => t.name).filter(Boolean) as string[];
      let buffer = "";
      let currentToolCall: any = null;
      let currentTextId: string | null = null;
      const flushText = (ctrl: any, text?: string) => {
        const content = text ?? buffer;
        if (content) {
          if (!currentTextId) currentTextId = generateId();
          ctrl.enqueue({
            type: "text-delta",
            id: currentTextId,
            textDelta: content,
          });
          if (!text) buffer = "";
        }
        if (currentTextId && !text) currentTextId = null;
      };
      return new TransformStream({
        transform(chunk, controller) {
          if (chunk.type !== "text-delta") {
            if (buffer) flushText(controller);
            controller.enqueue(chunk);
            return;
          }
          buffer += chunk.textDelta;
          while (true) {
            if (currentToolCall) {
              const endTag = `</${currentToolCall.name}>`;
              const endIdx = buffer.indexOf(endTag);
              if (endIdx === -1) break;
              const content = buffer.substring(0, endIdx);
              buffer = buffer.substring(endIdx + endTag.length);
              handleStreamingToolCallEnd({
                toolContent: content,
                currentToolCall,
                tools,
                options,
                ctrl: controller,
                flushText,
                pipelineConfig,
                maxReparses,
              });
              currentToolCall = null;
            } else {
              let earliest: any = null;
              for (const name of toolNames) {
                const openIdx = buffer.indexOf(`<${name}>`);
                const selfIdx = buffer.indexOf(`<${name}/>`);
                const tagIdx =
                  selfIdx !== -1 && (openIdx === -1 || selfIdx < openIdx)
                    ? selfIdx
                    : openIdx;
                if (tagIdx !== -1 && (!earliest || tagIdx < earliest.idx))
                  earliest = { name, idx: tagIdx, self: tagIdx === selfIdx };
              }
              if (!earliest) break;
              flushText(controller, buffer.substring(0, earliest.idx));
              buffer = buffer.substring(
                earliest.idx +
                  (earliest.self
                    ? `<${earliest.name}/>`.length
                    : `<${earliest.name}>`.length)
              );
              if (earliest.self)
                handleStreamingToolCallEnd({
                  toolContent: "",
                  currentToolCall: { name: earliest.name },
                  tools,
                  options,
                  ctrl: controller,
                  flushText,
                  pipelineConfig,
                  maxReparses,
                });
              else currentToolCall = { name: earliest.name };
            }
          }
        },
        flush(controller) {
          if (buffer) flushText(controller);
        },
      });
    },
  };
};
