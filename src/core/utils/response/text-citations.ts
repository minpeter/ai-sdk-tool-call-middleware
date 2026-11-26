import type {
  LanguageModelV4Citation,
  LanguageModelV4Content,
  LanguageModelV4StreamPart,
  SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import { generateId } from "../primitives/id";

type TextContent = Extract<LanguageModelV4Content, { type: "text" }>;

/**
 * Citation offsets index into the provider's text block. Once tool-call
 * markup is excised that block is re-segmented, so an offset is only kept
 * when the cited range lies wholly inside one surviving segment (shifted to
 * that segment). Otherwise the citation keeps its source and cited passage
 * but drops the offsets rather than pointing at the wrong characters.
 */
function withoutOffsets(
  citation: LanguageModelV4Citation
): LanguageModelV4Citation {
  const {
    startIndex: _startIndex,
    endIndex: _endIndex,
    ...unanchored
  } = citation;
  return unanchored;
}

function hasOffsets(
  citation: LanguageModelV4Citation
): citation is LanguageModelV4Citation & {
  startIndex: number;
  endIndex: number;
} {
  return (
    typeof citation.startIndex === "number" &&
    typeof citation.endIndex === "number" &&
    Number.isInteger(citation.startIndex) &&
    Number.isInteger(citation.endIndex) &&
    citation.startIndex >= 0 &&
    citation.endIndex >= citation.startIndex
  );
}

/**
 * Re-anchor one citation to a segment that starts at `segmentOffset` of the
 * provider text. Returns null when the cited range is not inside the segment.
 */
function shiftIntoSegment(
  citation: LanguageModelV4Citation,
  segmentOffset: number,
  segmentLength: number
): LanguageModelV4Citation | null {
  if (!hasOffsets(citation)) {
    return null;
  }
  const { startIndex, endIndex } = citation;
  if (
    startIndex < segmentOffset ||
    endIndex > segmentOffset + segmentLength ||
    endIndex < startIndex
  ) {
    return null;
  }
  return segmentOffset === 0
    ? citation
    : {
        ...citation,
        startIndex: startIndex - segmentOffset,
        endIndex: endIndex - segmentOffset,
      };
}

/**
 * Distribute a provider text block's citations over the text segments that
 * remain after tool-call parsing. Each entry of the result lines up with
 * `segmentTexts`.
 */
export function remapCitationsToSegments(
  citations: LanguageModelV4Citation[],
  providerText: string,
  segmentTexts: string[]
): LanguageModelV4Citation[][] {
  const perSegment: LanguageModelV4Citation[][] = segmentTexts.map(() => []);
  if (segmentTexts.length === 0) {
    return perSegment;
  }

  const offsets: number[] = [];
  const allTextSurvives = segmentTexts.join("") === providerText;
  let cursor = 0;
  for (const segmentText of segmentTexts) {
    const offset = providerText.indexOf(segmentText, cursor);
    // A removed tool argument may contain the same text as a surviving
    // segment. Without parser-provided source spans, choosing the first
    // occurrence could attach that argument's citation to unrelated text.
    const isUnambiguous =
      segmentText.length > 0 &&
      (allTextSurvives ||
        providerText.indexOf(segmentText) ===
          providerText.lastIndexOf(segmentText));
    offsets.push(isUnambiguous ? offset : -1);
    if (offset !== -1) {
      cursor = offset + segmentText.length;
    }
  }

  const lastSegment = segmentTexts.length - 1;
  for (const citation of citations) {
    let placed = false;
    for (const [index, segmentText] of segmentTexts.entries()) {
      const offset = offsets[index];
      if (offset === -1) {
        continue;
      }
      const shifted = shiftIntoSegment(citation, offset, segmentText.length);
      if (shifted) {
        perSegment[index].push(shifted);
        placed = true;
        break;
      }
    }
    if (!placed) {
      perSegment[lastSegment].push(withoutOffsets(citation));
    }
  }
  return perSegment;
}

/**
 * Carry a generated text part's citations and provider metadata across
 * tool-call parsing. Protocol parsers rebuild text parts from scratch, which
 * would silently drop both.
 */
export function carryTextPartAnnotations(
  original: TextContent,
  parsed: LanguageModelV4Content[]
): LanguageModelV4Content[] {
  const { citations, providerMetadata } = original;
  const hasCitations = Array.isArray(citations) && citations.length > 0;
  if (!hasCitations && providerMetadata === undefined) {
    return parsed;
  }

  const textIndexes: number[] = [];
  for (const [index, part] of parsed.entries()) {
    if (part.type === "text") {
      textIndexes.push(index);
    }
  }
  if (textIndexes.length === 0) {
    return hasCitations
      ? [
          ...parsed,
          { type: "text", text: "", citations: citations.map(withoutOffsets) },
        ]
      : parsed;
  }

  const providerText = original.text;
  const segmentTexts = textIndexes.map(
    (index) => (parsed[index] as TextContent).text
  );
  const perSegment = hasCitations
    ? remapCitationsToSegments(citations, providerText, segmentTexts)
    : [];
  // Provider metadata describes the provider's block (for example an item id
  // that is replayed in history), so it only survives when the block does.
  const isUntouchedBlock =
    parsed.length === 1 && segmentTexts[0] === providerText;

  const result = [...parsed];
  for (const [segment, index] of textIndexes.entries()) {
    const part = parsed[index] as TextContent;
    const segmentCitations = perSegment[segment] ?? [];
    result[index] = {
      ...part,
      ...(segmentCitations.length > 0 && !part.citations?.length
        ? { citations: segmentCitations }
        : {}),
      ...(isUntouchedBlock &&
      providerMetadata !== undefined &&
      part.providerMetadata === undefined
        ? { providerMetadata }
        : {}),
    };
  }
  return result;
}

/**
 * Re-anchor a closed provider block's citations to the parser's output text
 * block. Parsers merge consecutive provider blocks into one output block and
 * cut tool-call markup out of it, so the provider text may sit inside the
 * output block or the other way around.
 */
function remapCitationsToOutputBlock(
  citations: LanguageModelV4Citation[],
  providerText: string,
  outputText: string
): LanguageModelV4Citation[] {
  const providerOffset =
    providerText.length > 0 ? outputText.indexOf(providerText) : -1;
  if (providerOffset === -1) {
    return remapCitationsToSegments(citations, providerText, [outputText])[0];
  }
  if (providerOffset !== outputText.lastIndexOf(providerText)) {
    // The block's text repeats inside the merged output, so its position is
    // ambiguous; an unanchored citation beats a wrongly anchored one.
    return citations.map(withoutOffsets);
  }
  return citations.map((citation) =>
    hasOffsets(citation) &&
    citation.startIndex <= citation.endIndex &&
    citation.endIndex <= providerText.length
      ? {
          ...citation,
          startIndex: citation.startIndex + providerOffset,
          endIndex: citation.endIndex + providerOffset,
        }
      : withoutOffsets(citation)
  );
}

/**
 * In-band marker for a provider text block that closed with annotations. It
 * travels through the protocol stream parser as a `raw` part (parsers forward
 * those in order without treating them as a content boundary) and is consumed
 * by `createCitationRestoreTransform`; it never reaches the caller.
 */
class ClosedTextBlockAnnotations {
  bufferedOutputId?: string;
  readonly citations: LanguageModelV4Citation[];
  readonly providerId: string;
  readonly providerText: string;
  readonly providerMetadata: SharedV4ProviderMetadata | undefined;

  constructor(
    citations: LanguageModelV4Citation[],
    providerId: string,
    providerText: string,
    providerMetadata: SharedV4ProviderMetadata | undefined
  ) {
    this.citations = citations;
    this.providerId = providerId;
    this.providerText = providerText;
    this.providerMetadata = providerMetadata;
  }
}

type StreamPart = LanguageModelV4StreamPart;
type StreamController = TransformStreamDefaultController<StreamPart>;

/** Remember the parser's block ID when JSON recovery has not emitted its start yet. */
export function trackBufferedTextAnnotations(
  part: StreamPart,
  id: string | undefined
) {
  if (
    id !== undefined &&
    part.type === "raw" &&
    part.rawValue instanceof ClosedTextBlockAnnotations
  ) {
    part.rawValue.bufferedOutputId = id;
  }
}

function accumulateTextBlock(blocks: Map<string, string>, part: StreamPart) {
  if (part.type === "text-start") {
    blocks.set(part.id, "");
  } else if (part.type === "text-delta") {
    const text = blocks.get(part.id);
    if (text !== undefined) {
      blocks.set(part.id, text + part.delta);
    }
  }
}

/**
 * Runs before the protocol stream parser. Parsers drop the provider's
 * `text-start` / `text-end` envelopes because they re-segment text under
 * their own ids, which would also drop the citations attached to `text-end`.
 * This records them as an in-band marker the restore transform re-attaches.
 */
export function createCitationCaptureTransform(): TransformStream<
  StreamPart,
  StreamPart
> {
  const providerBlocks = new Map<string, string>();
  const metadata = new Map<string, SharedV4ProviderMetadata>();
  return new TransformStream<StreamPart, StreamPart>({
    transform(part, controller) {
      accumulateTextBlock(providerBlocks, part);
      if (part.type === "text-start") {
        metadata.delete(part.id);
      }
      if (
        (part.type === "text-start" ||
          part.type === "text-delta" ||
          part.type === "text-end") &&
        part.providerMetadata !== undefined
      ) {
        // Match the SDK: the last defined metadata on a text block wins.
        metadata.set(part.id, part.providerMetadata);
      }
      if (part.type === "text-end") {
        const providerText = providerBlocks.get(part.id) ?? "";
        providerBlocks.delete(part.id);
        const providerMetadata = metadata.get(part.id);
        metadata.delete(part.id);
        const citations = Array.isArray(part.citations) ? part.citations : [];
        if (citations.length > 0 || providerMetadata !== undefined) {
          controller.enqueue({
            type: "raw",
            rawValue: new ClosedTextBlockAnnotations(
              citations,
              part.id,
              providerText,
              providerMetadata
            ),
          });
        }
      }
      controller.enqueue(part);
    },
  });
}

/**
 * Runs after the protocol stream parser. Re-attaches captured citations to
 * an output block that was open when the provider block closed. If the
 * parser already closed that output block, publish the citations without
 * offsets on an empty block; assigning them to a later block could cite
 * unrelated text that happens to repeat the same words.
 */
export function createCitationRestoreTransform(): TransformStream<
  StreamPart,
  StreamPart
> {
  let pending: Array<{
    block: ClosedTextBlockAnnotations;
    outputIds: Set<string>;
  }> = [];
  const outputBlocks = new Map<string, string>();

  const publishDetached = (controller: StreamController) => {
    const citations = pending.flatMap(({ block }) =>
      block.citations.map(withoutOffsets)
    );
    pending = [];
    if (citations.length === 0) {
      return;
    }
    const id = generateId();
    controller.enqueue({ type: "text-start", id });
    controller.enqueue({
      type: "text-end",
      id,
      citations,
    });
  };

  const restoreAnnotations = (
    part: Extract<StreamPart, { type: "text-end" }>
  ): Extract<StreamPart, { type: "text-end" }> => {
    const outputText = outputBlocks.get(part.id);
    outputBlocks.delete(part.id);
    if (pending.length === 0 || outputText === undefined) {
      return part;
    }
    // Custom protocols may retain the original envelope or annotations.
    const matches = ({ block, outputIds }: (typeof pending)[number]) =>
      outputIds.has(part.id) ||
      block.providerId === part.id ||
      (part.citations !== undefined && block.citations === part.citations);
    const matching = pending.filter(matches);
    const citations = matching.flatMap(({ block }) =>
      remapCitationsToOutputBlock(
        block.citations,
        block.providerText,
        outputText
      )
    );
    pending = pending.filter((capture) => !matches(capture));
    // Metadata such as a replayable item ID describes the whole provider
    // block. Never copy it to split, merged, or detached text.
    const providerMetadata =
      matching.length === 1 && matching[0].block.providerText === outputText
        ? matching[0].block.providerMetadata
        : undefined;
    return {
      ...part,
      ...(!part.citations?.length && citations.length > 0 ? { citations } : {}),
      ...(part.providerMetadata === undefined && providerMetadata !== undefined
        ? { providerMetadata }
        : {}),
    };
  };

  return new TransformStream<StreamPart, StreamPart>({
    transform(part, controller) {
      if (
        part.type === "raw" &&
        part.rawValue instanceof ClosedTextBlockAnnotations
      ) {
        const outputIds = new Set(outputBlocks.keys());
        if (part.rawValue.bufferedOutputId !== undefined) {
          outputIds.add(part.rawValue.bufferedOutputId);
        }
        pending.push({
          block: part.rawValue,
          outputIds,
        });
        return;
      }

      accumulateTextBlock(outputBlocks, part);
      if (part.type === "text-end") {
        controller.enqueue(restoreAnnotations(part));
        return;
      }
      if (part.type === "finish") {
        publishDetached(controller);
      }
      controller.enqueue(part);
    },
    flush(controller) {
      publishDetached(controller);
    },
  });
}
