import type { ToolCallProtocol } from "../core/protocols/tool-call-protocol";
import type { TCMCoreFunctionTool, TCMCoreStreamPart } from "../core/types";
import {
  getDebugLevel,
  logParsedChunk,
  logRawChunk,
} from "../core/utils/debug";
import { generateId } from "../core/utils/id";
import { originalToolsSchema } from "../core/utils/provider-options";

interface V5TransformerState {
  textStarted: Set<string>;
  toolStarted: Set<string>;
  callCount: number;
}

function processPartToV2(
  p: TCMCoreStreamPart,
  state: V5TransformerState,
  controller: TransformStreamDefaultController<unknown>
) {
  // biome-ignore lint/suspicious/noExplicitAny: mapping for v2 provider compatibility
  const partAny = p as any;
  const partId = partAny.id || partAny.toolCallId || generateId();

  switch (p.type) {
    case "text-delta": {
      if (!state.textStarted.has(partId)) {
        controller.enqueue({ type: "text-start", id: partId });
        state.textStarted.add(partId);
      }
      controller.enqueue({
        type: "text-delta",
        id: partId,
        delta: p.textDelta,
      });
      break;
    }
    case "tool-call": {
      const v2Id = p.toolCallId || `call-${state.callCount++}`;
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
      for (const id of state.textStarted) {
        controller.enqueue({ type: "text-end", id });
      }
      state.textStarted.clear();
      controller.enqueue(p);
      break;
    }
    default: {
      controller.enqueue(p);
    }
  }
}

export function createV5Transformer(
  debugLevel: "off" | "stream" | "parse" = "off"
): TransformStream<TCMCoreStreamPart, unknown> {
  const state: V5TransformerState = {
    textStarted: new Set(),
    toolStarted: new Set(),
    callCount: 0,
  };

  return new TransformStream<TCMCoreStreamPart, unknown>({
    transform(part, controller) {
      if (debugLevel === "stream") {
        logParsedChunk(part);
      }
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
  ) as TCMCoreFunctionTool[];
  const options = params.providerOptions?.toolCallMiddleware || {};
  const debugLevel = getDebugLevel();

  const { stream } = await doStream();

  const coreInput = (stream as ReadableStream<unknown>).pipeThrough(
    new TransformStream<unknown, TCMCoreStreamPart>({
      transform(part, controller) {
        if (debugLevel === "stream") {
          logRawChunk(part);
        }
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
    stream: parsedStream.pipeThrough(createV5Transformer(debugLevel)),
  };
}
