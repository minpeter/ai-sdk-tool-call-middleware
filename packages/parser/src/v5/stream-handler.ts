import type { ToolCallProtocol } from "../core/protocols/tool-call-protocol";
import type { CoreFunctionTool, CoreStreamPart } from "../core/types";
import { originalToolsSchema } from "../core/utils/provider-options";

interface V5TransformerState {
  textStarted: boolean;
  toolStarted: Set<string>;
  callCount: number;
}

function processPartToV2(
  p: CoreStreamPart,
  state: V5TransformerState,
  controller: TransformStreamDefaultController<unknown>
) {
  const v2TextId = "txt-0";

  switch (p.type) {
    case "text-delta": {
      if (!state.textStarted) {
        controller.enqueue({ type: "text-start", id: v2TextId });
        state.textStarted = true;
      }
      controller.enqueue({
        type: "text-delta",
        id: v2TextId,
        delta: p.textDelta,
      });
      break;
    }
    case "tool-call": {
      const v2Id = `call-${state.callCount++}`;
      if (!state.toolStarted.has(v2Id)) {
        controller.enqueue({
          type: "tool-input-start",
          id: v2Id,
          toolName: p.toolName,
        });
        state.toolStarted.add(v2Id);
      }
      controller.enqueue({
        type: "tool-call",
        toolCallId: v2Id,
        toolName: p.toolName,
        input: typeof p.input === "string" ? JSON.parse(p.input) : p.input,
      });
      break;
    }
    case "finish": {
      if (state.textStarted) {
        controller.enqueue({ type: "text-end", id: v2TextId });
        state.textStarted = false;
      }
      controller.enqueue(p);
      break;
    }
    default: {
      controller.enqueue(p);
    }
  }
}

export function createV5Transformer(): TransformStream<
  CoreStreamPart,
  unknown
> {
  const state: V5TransformerState = {
    textStarted: false,
    toolStarted: new Set(),
    callCount: 0,
  };

  return new TransformStream<CoreStreamPart, unknown>({
    transform(part, controller) {
      processPartToV2(part, state, controller);
    },
  });
}

export async function wrapStreamV5({
  protocol,
  doStream,
  params,
}: {
  protocol: ToolCallProtocol;
  doStream: () => Promise<{ stream: unknown }>;
  // biome-ignore lint/suspicious/noExplicitAny: complex provider options mapping
  params: { providerOptions?: { toolCallMiddleware?: any } };
}) {
  const tools = originalToolsSchema.decode(
    params.providerOptions?.toolCallMiddleware?.originalTools
  ) as CoreFunctionTool[];
  const options = params.providerOptions?.toolCallMiddleware || {};

  const { stream } = await doStream();

  const coreInput = (stream as ReadableStream<unknown>).pipeThrough(
    new TransformStream<unknown, CoreStreamPart>({
      transform(part, controller) {
        // biome-ignore lint/suspicious/noExplicitAny: complex stream part mapping
        const p = part as any;
        if (p.type === "text-delta") {
          controller.enqueue({
            type: "text-delta",
            id: p.id,
            textDelta: p.delta || p.textDelta || "",
          });
        } else {
          controller.enqueue(p);
        }
      },
    })
  );

  const parsedStream = coreInput.pipeThrough(
    protocol.createStreamParser({
      tools,
      options,
    })
  );

  return {
    stream: parsedStream.pipeThrough(createV5Transformer()),
  };
}
