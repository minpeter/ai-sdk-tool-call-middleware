import {
  isProtocolFactory,
  type ToolCallProtocol,
} from "../core/protocols/tool-call-protocol";
import { createDynamicIfThenElseSchema } from "../core/utils/dynamic-tool-schema";
import { extractOnErrorOption } from "../core/utils/on-error";
import { originalToolsSchema } from "../core/utils/provider-options";
import { isToolCallContent } from "../core/utils/type-guards";

/**
 * Build final prompt by merging system prompt with existing prompt
 */
function buildFinalPrompt(
  systemPrompt: string,
  processedPrompt: any[],
  placement: "first" | "last"
): any[] {
  const systemIndex = processedPrompt.findIndex((m) => m.role === "system");
  if (systemIndex !== -1) {
    const existing = processedPrompt[systemIndex].content;
    let existingText = "";
    if (typeof existing === "string") {
      existingText = existing;
    } else if (Array.isArray(existing)) {
      existingText = (existing as { type?: string; text?: string }[])
        .map((p) => (p?.type === "text" ? (p.text ?? "") : ""))
        .filter(Boolean)
        .join("\n");
    } else {
      existingText = String(existing ?? "");
    }

    const mergedContent =
      placement === "first"
        ? `${systemPrompt}\n\n${existingText}`
        : `${existingText}\n\n${systemPrompt}`;

    return processedPrompt.map((m, idx) =>
      idx === systemIndex
        ? {
            ...m,
            content: mergedContent,
          }
        : m
    );
  }

  if (placement === "first") {
    return [
      {
        role: "system",
        content: systemPrompt,
      },
      ...processedPrompt,
    ];
  }

  return [
    ...processedPrompt,
    {
      role: "system",
      content: systemPrompt,
    },
  ];
}

/**
 * Process assistant message content
 */
function processAssistantContent(
  content: any[],
  resolvedProtocol: ToolCallProtocol,
  providerOptions?: {
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
  }
): any[] {
  const newContent: any[] = [];
  for (const item of content) {
    if (isToolCallContent(item)) {
      newContent.push({
        type: "text",
        text: resolvedProtocol.formatToolCall(item as any),
      });
    } else if (item.type === "text") {
      newContent.push(item);
    } else if (item.type === "reasoning") {
      newContent.push(item);
    } else {
      const options = extractOnErrorOption(providerOptions);
      options?.onError?.(
        "tool-call-middleware: unknown assistant content; stringifying for provider compatibility",
        { content: item }
      );
      newContent.push({
        type: "text",
        text: JSON.stringify(item),
      });
    }
  }

  const onlyText = newContent.every((c) => c.type === "text");
  return onlyText
    ? [
        {
          type: "text",
          text: newContent.map((c) => c.text).join("\n"),
        },
      ]
    : newContent;
}

function processMessage(
  message: any,
  resolvedProtocol: ToolCallProtocol,
  providerOptions?: any
): any {
  if (message.role === "assistant") {
    const content = Array.isArray(message.content)
      ? message.content
      : [{ type: "text", text: message.content }];
    const condensedContent = processAssistantContent(
      content,
      resolvedProtocol,
      providerOptions
    );
    return {
      ...message,
      content: condensedContent,
    };
  }
  if (message.role === "tool") {
    const toolResultParts = message.content.filter(
      (part: any) => part.type === "tool-result"
    );
    return {
      role: "user",
      content: [
        {
          type: "text",
          text: toolResultParts
            .map((toolResult: any) =>
              resolvedProtocol.formatToolResponse(toolResult)
            )
            .join("\n"),
        },
      ],
    };
  }
  return message;
}

export function transformParamsV5({
  params,
  protocol,
  toolSystemPromptTemplate,
  placement = "first",
}: {
  params: any;
  protocol: ToolCallProtocol | (() => ToolCallProtocol);
  toolSystemPromptTemplate: (tools: string) => string;
  placement?: "first" | "last";
}) {
  const resolvedProtocol = isProtocolFactory(protocol) ? protocol() : protocol;

  const functionTools = (params.tools ?? []).filter(
    (t: any) => t.type === "function"
  );

  const systemPrompt = resolvedProtocol.formatTools({
    tools: functionTools,
    toolSystemPromptTemplate,
  });

  const prompt = params.prompt ?? [];
  const processedPrompt = prompt.map((message: any) =>
    processMessage(
      message,
      resolvedProtocol,
      extractOnErrorOption(params.providerOptions)
    )
  );

  const finalPrompt = buildFinalPrompt(
    systemPrompt,
    processedPrompt,
    placement
  );

  const baseReturnParams = {
    ...params,
    prompt: finalPrompt,
    tools: [],
    toolChoice: undefined,
    providerOptions: {
      ...(params.providerOptions || {}),
      toolCallMiddleware: {
        ...(params.providerOptions?.toolCallMiddleware || {}),
        originalTools: originalToolsSchema.encode(functionTools),
      },
    },
  };

  if (params.toolChoice?.type === "tool") {
    const selectedToolName = params.toolChoice.toolName;
    const selectedTool = functionTools.find(
      (t: any) => t.name === selectedToolName
    );
    if (selectedTool) {
      return {
        ...baseReturnParams,
        responseFormat: {
          type: "json",
          schema: {
            type: "object",
            properties: {
              name: { const: selectedTool.name },
              arguments: selectedTool.inputSchema,
            },
            required: ["name", "arguments"],
          },
        },
        providerOptions: {
          ...baseReturnParams.providerOptions,
          toolCallMiddleware: {
            ...baseReturnParams.providerOptions.toolCallMiddleware,
            toolChoice: params.toolChoice,
          },
        },
      };
    }
  }

  if (params.toolChoice?.type === "required") {
    return {
      ...baseReturnParams,
      responseFormat: {
        type: "json",
        schema: createDynamicIfThenElseSchema(functionTools),
      },
      providerOptions: {
        ...baseReturnParams.providerOptions,
        toolCallMiddleware: {
          ...baseReturnParams.providerOptions.toolCallMiddleware,
          toolChoice: { type: "required" },
        },
      },
    };
  }

  return baseReturnParams;
}
