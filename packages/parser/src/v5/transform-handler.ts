import {
  isProtocolFactory,
  type ToolCallProtocol,
} from "../core/protocols/tool-call-protocol";
import type { TCMToolDefinition } from "../core/types";
import { createDynamicIfThenElseSchema } from "../core/utils/dynamic-tool-schema";
import { extractOnErrorOption } from "../core/utils/on-error";
import { originalToolsSchema } from "../core/utils/provider-options";
import { isToolCallContent } from "../core/utils/type-guards";

// biome-ignore lint/suspicious/noExplicitAny: AI SDK v5 prompt message types
type V5Message = any;

function buildFinalPrompt(
  systemPrompt: string,
  processedPrompt: V5Message[],
  placement: "first" | "last"
): V5Message[] {
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

// biome-ignore lint/suspicious/noExplicitAny: AI SDK v5 content item types
type V5ContentItem = any;

function processAssistantContent(
  content: V5ContentItem[],
  resolvedProtocol: ToolCallProtocol,
  providerOptions?: {
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
  }
): V5ContentItem[] {
  const newContent: V5ContentItem[] = [];
  for (const item of content) {
    if (isToolCallContent(item)) {
      newContent.push({
        type: "text",
        text: resolvedProtocol.formatToolCall(item as V5ContentItem),
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
  message: V5Message,
  resolvedProtocol: ToolCallProtocol,
  // biome-ignore lint/suspicious/noExplicitAny: AI SDK v5 provider options
  providerOptions?: any
): V5Message {
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
      (part: V5ContentItem) => part.type === "tool-result"
    );
    return {
      role: "user",
      content: [
        {
          type: "text",
          text: toolResultParts
            .map((toolResult: V5ContentItem) =>
              resolvedProtocol.formatToolResponse({
                ...toolResult,
                result:
                  toolResult.result ?? toolResult.content ?? toolResult.output,
              })
            )
            .join("\n"),
        },
      ],
    };
  }
  return message;
}

function isAllTextContent(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return false;
  }
  return (content as { type: string }[]).every(
    (c: { type: string }) => c?.type === "text"
  );
}

function joinTextContent(content: { text: string }[]): string {
  return content.map((c) => c.text).join("\n");
}

function createCondensedMessage(role: string, joinedText: string): V5Message {
  if (role === "system") {
    return {
      role: "system",
      content: joinedText,
    };
  }

  return {
    role,
    content: [
      {
        type: "text",
        text: joinedText,
      },
    ],
  };
}

function condenseTextContent(processedPrompt: V5Message[]): V5Message[] {
  for (let i = 0; i < processedPrompt.length; i += 1) {
    const msg = processedPrompt[i] as {
      role: string;
      content: unknown;
    };

    if (!Array.isArray(msg.content)) {
      continue;
    }

    const shouldCondense =
      isAllTextContent(msg.content) && msg.content.length > 1;
    if (shouldCondense) {
      const joinedText = joinTextContent(msg.content as { text: string }[]);
      processedPrompt[i] = createCondensedMessage(msg.role, joinedText);
    }
  }
  return processedPrompt;
}

function mergeConsecutiveUserMessages(
  processedPrompt: V5Message[]
): V5Message[] {
  for (let i = processedPrompt.length - 1; i > 0; i -= 1) {
    const current = processedPrompt[i];
    const prev = processedPrompt[i - 1];
    if (current.role === "user" && prev.role === "user") {
      const prevContent = prev.content
        .map((c: V5ContentItem) => (c.type === "text" ? c.text : ""))
        .join("\n");
      const currentContent = current.content
        .map((c: V5ContentItem) => (c.type === "text" ? c.text : ""))
        .join("\n");
      processedPrompt[i - 1] = {
        role: "user",
        content: [{ type: "text", text: `${prevContent}\n${currentContent}` }],
      };
      processedPrompt.splice(i, 1);
    }
  }
  return processedPrompt;
}

function convertToolPrompt(
  prompt: V5Message[],
  resolvedProtocol: ToolCallProtocol,
  providerOptions?: {
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
  }
): V5Message[] {
  let processedPrompt = prompt.map((message: V5Message) =>
    processMessage(message, resolvedProtocol, providerOptions)
  );

  processedPrompt = condenseTextContent(processedPrompt);
  processedPrompt = mergeConsecutiveUserMessages(processedPrompt);
  return processedPrompt;
}

// biome-ignore lint/suspicious/noExplicitAny: AI SDK v5 params structure
type V5Params = any;

// biome-ignore lint/suspicious/noExplicitAny: AI SDK v5 tool definition
type V5Tool = any;

export function transformParamsV5({
  params,
  protocol,
  toolSystemPromptTemplate,
  placement = "first",
}: {
  params: V5Params;
  protocol: ToolCallProtocol | (() => ToolCallProtocol);
  toolSystemPromptTemplate: (tools: TCMToolDefinition[]) => string;
  placement?: "first" | "last";
}) {
  const resolvedProtocol = isProtocolFactory(protocol) ? protocol() : protocol;

  const functionTools = (params.tools ?? []).filter(
    (t: V5Tool) => t.type === "function"
  );

  const systemPrompt = resolvedProtocol.formatTools({
    tools: functionTools,
    toolSystemPromptTemplate,
  });

  const prompt = params.prompt ?? [];
  const processedPrompt = convertToolPrompt(
    prompt,
    resolvedProtocol,
    extractOnErrorOption(params.providerOptions)
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

  if (params.toolChoice?.type === "none") {
    throw new Error(
      "The 'none' toolChoice type is not supported by this middleware. Please use 'auto', 'required', or specify a tool name."
    );
  }

  if (params.toolChoice?.type === "tool") {
    const selectedToolName = params.toolChoice.toolName;
    const selectedTool = functionTools.find(
      (t: V5Tool) => t.name === selectedToolName
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
