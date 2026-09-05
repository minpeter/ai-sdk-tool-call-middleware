import type { ProviderCaptureRecord } from "./provider-capture";
import {
  isSse,
  parseCapturedSseChunks as parseSseChunks,
  providerTools,
  replayCalls,
  replayText,
  responsePayloads,
  streamProviderParts,
  textChunks,
} from "./replay-provider-capture-analysis";
import {
  replayGenerate,
  replayStream,
  validateGlm5ChunkInvariance,
} from "./replay-provider-capture-lifecycle";

export type ReplayParserChoice = "auto" | "glm5" | "native";

export type ReplayParserMode = "glm5" | "native";

interface CaptureReplayCall {
  arguments: unknown;
  name: string;
  safeName: string;
}

interface ChunkInvarianceResult {
  checked: boolean;
  normalizedSnapshotSha256?: string;
  sseByteChunkVariants: number;
  streamDeltaChunkVariants: number;
}

export interface CaptureResponseReplay {
  calls: CaptureReplayCall[];
  chunkInvariance: ChunkInvarianceResult;
  parser: ReplayParserMode;
  rawText: string;
  responseChunks: number;
  text: string;
}

export const parseCapturedSseChunks = parseSseChunks;

export function replayParserMode(
  arm: string,
  choice: ReplayParserChoice
): ReplayParserMode {
  if (choice === "native") {
    return "native";
  }
  if (choice === "glm5") {
    return "glm5";
  }
  switch (arm) {
    case "native":
      return "native";
    case "glm5":
      return "glm5";
    default:
      throw new Error(
        `--parser auto has no response semantics for capture arm ${arm}`
      );
  }
}

export async function replayProviderCaptureResponse(
  record: ProviderCaptureRecord,
  parserChoice: ReplayParserChoice,
  errors: string[] = []
): Promise<CaptureResponseReplay> {
  const parser = replayParserMode(record.context.arm, parserChoice);
  const payloads = responsePayloads(record, errors);
  const rawChunks = textChunks(payloads, record.context.transport);
  const rawText = rawChunks.join("");
  const tools = providerTools(record.context.tools);
  const middlewareContext = { errors, tools };

  if (record.context.transport === "generate") {
    const content = await replayGenerate(payloads, parser, middlewareContext);
    return {
      calls: replayCalls(content, record.context.tools),
      chunkInvariance: {
        checked: false,
        sseByteChunkVariants: 0,
        streamDeltaChunkVariants: 0,
      },
      parser,
      rawText,
      responseChunks: rawChunks.length,
      text: replayText(content),
    };
  }

  const providerParts = streamProviderParts(payloads, errors);
  const output = await replayStream(providerParts, parser, middlewareContext);
  const chunkInvariance =
    parser === "glm5" && isSse(record)
      ? await validateGlm5ChunkInvariance({
          baselineOutput: output,
          body: record.response?.body ?? "",
          captureId: record.captureId,
          providerParts,
          tools,
        })
      : {
          checked: false,
          sseByteChunkVariants: 0,
          streamDeltaChunkVariants: 0,
        };
  return {
    calls: replayCalls(output, record.context.tools),
    chunkInvariance,
    parser,
    rawText,
    responseChunks: rawChunks.length,
    text: replayText(output),
  };
}
