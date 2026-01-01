import { coerceBySchema } from "@ai-sdk-tool/rxml";
import type { ToolCallProtocol } from "../core/protocols/tool-call-protocol";
import { extractOnErrorOption } from "../core/utils/on-error";
import { originalToolsSchema } from "../core/utils/provider-options";

function parseContent(
  content: any[],
  protocol: ToolCallProtocol,
  tools: any[],
  providerOptions?: any
): any[] {
  const parsed = content.flatMap((contentItem) => {
    if (contentItem.type !== "text") {
      return [contentItem];
    }
    return protocol.parseGeneratedText({
      text: contentItem.text,
      tools,
      options: {
        ...extractOnErrorOption(providerOptions),
        ...(providerOptions?.toolCallMiddleware || {}),
      },
    });
  });

  return parsed.map((part) => {
    if (part.type !== "tool-call") {
      return part;
    }
    const tc = part as { toolName: string; input: any };
    let args: any = {};
    if (typeof tc.input === "string") {
      try {
        args = JSON.parse(tc.input);
      } catch {
        return part;
      }
    } else {
      args = tc.input;
    }
    const schema = tools.find((t) => t.name === tc.toolName)?.inputSchema;
    const coerced = coerceBySchema(args, schema);
    return {
      ...part,
      input: coerced ?? {},
    };
  });
}

export async function wrapGenerateV5({
  protocol,
  doGenerate,
  params,
}: {
  protocol: ToolCallProtocol;
  doGenerate: () => Promise<any>;
  params: any;
}) {
  const tools = originalToolsSchema.decode(
    params.providerOptions?.toolCallMiddleware?.originalTools
  );

  const result = await doGenerate();

  if (!result.content || result.content.length === 0) {
    return result;
  }

  const newContent = parseContent(
    result.content,
    protocol,
    tools,
    params.providerOptions
  );

  return {
    ...result,
    content: newContent,
  };
}
