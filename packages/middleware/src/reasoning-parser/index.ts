/**
 * @license
 * Copyright (c) 2021-present, FriendliAI Inc. All rights reserved.
 */

import type {
  LanguageModelV3Content,
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";

/**
 * All code below is forked from the following link:
 * https://github.com/vercel/ai/blob/v5/packages/ai/core/middleware/extract-reasoning-middleware.ts
 */

/**
 * Returns the index of the start of the searchedText in the text, or null if it
 * is not found.
 */
export function getPotentialStartIndex(
  text: string,
  searchedText: string
): number | null {
  // Return null immediately if searchedText is empty.
  if (searchedText.length === 0) {
    return null;
  }

  // Check if the searchedText exists as a direct substring of text.
  const directIndex = text.indexOf(searchedText);
  if (directIndex !== -1) {
    return directIndex;
  }

  // Otherwise, look for the largest suffix of "text" that matches
  // a prefix of "searchedText". We go from the end of text inward.
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const suffix = text.substring(i);
    if (searchedText.startsWith(suffix)) {
      return i;
    }
  }

  return null;
}

/**
 * Extract an XML-tagged reasoning section from the generated text and exposes it
 * as a `reasoning` property on the result.
 *
 * @param openingTag - The opening XML tag to extract reasoning from.
 * @param closingTag - The closing XML tag to extract reasoning from.
 * @param separator - The separator to use between reasoning and text sections.
 * @param startWithReasoning - Whether to start with reasoning tokens.
 */
export function extractReasoningMiddleware({
  openingTag,
  closingTag,
  separator = "\n",
  startWithReasoning = false,
}: {
  openingTag: string;
  closingTag: string;
  separator?: string;
  startWithReasoning?: boolean;
}): LanguageModelV3Middleware {
  function processTextPart(
    text: string,
    transformedContent: LanguageModelV3Content[]
  ) {
    const regexp = new RegExp(`${openingTag}(.*?)${closingTag}`, "gs");
    const matches = Array.from(text.matchAll(regexp));

    if (!matches.length) {
      return;
    }

    const reasoningText = matches.map((match) => match[1]).join(separator);

    let textWithoutReasoning = text;
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const match = matches[i];

      const beforeMatch = textWithoutReasoning.slice(0, match.index);
      const matchIndex = match.index ?? 0;
      const afterMatch = textWithoutReasoning.slice(
        matchIndex + match[0].length
      );

      textWithoutReasoning =
        beforeMatch +
        (beforeMatch.length > 0 && afterMatch.length > 0 ? separator : "") +
        afterMatch;
    }

    transformedContent.push({
      type: "reasoning",
      text: reasoningText,
    });

    transformedContent.push({
      type: "text",
      text: textWithoutReasoning,
    });
  }

  return {
    specificationVersion: "v3",
    wrapGenerate: async ({ doGenerate }) => {
      const { content, ...rest } = await doGenerate();

      const transformedContent: LanguageModelV3Content[] = [];
      for (const part of content) {
        if (part.type !== "text") {
          transformedContent.push(part);
          continue;
        }

        const text = startWithReasoning ? openingTag + part.text : part.text;
        const regexp = new RegExp(`${openingTag}(.*?)${closingTag}`, "gs");
        const matches = Array.from(text.matchAll(regexp));

        if (!matches.length) {
          transformedContent.push(part);
          continue;
        }

        processTextPart(text, transformedContent);
      }

      return { content: transformedContent, ...rest };
    },

    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream();

      interface ExtractionState {
        isFirstReasoning: boolean;
        isFirstText: boolean;
        afterSwitch: boolean;
        isReasoning: boolean;
        buffer: string;
        idCounter: number;
        textId: string;
      }

      const reasoningExtractions: Record<string, ExtractionState> = {};

      function createPublisher(
        activeExtraction: ExtractionState,
        controller: TransformStreamDefaultController<LanguageModelV3StreamPart>
      ) {
        return (text: string) => {
          if (text.length === 0) {
            return;
          }

          const prefix = getPrefix(activeExtraction);
          enqueueReasoningStart(activeExtraction, controller);
          enqueueDelta(activeExtraction, controller, prefix, text);
          updateExtractionState(activeExtraction);
        };
      }

      function getPrefix(activeExtraction: ExtractionState): string {
        return activeExtraction.afterSwitch &&
          (activeExtraction.isReasoning
            ? !activeExtraction.isFirstReasoning
            : !activeExtraction.isFirstText)
          ? separator
          : "";
      }

      function enqueueReasoningStart(
        activeExtraction: ExtractionState,
        controller: TransformStreamDefaultController<LanguageModelV3StreamPart>
      ) {
        if (
          (activeExtraction.afterSwitch && activeExtraction.isReasoning) ||
          activeExtraction.isFirstReasoning
        ) {
          controller.enqueue({
            type: "reasoning-start",
            id: `reasoning-${activeExtraction.idCounter}`,
          });
        }
      }

      function enqueueDelta(
        activeExtraction: ExtractionState,
        controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
        prefix: string,
        text: string
      ) {
        controller.enqueue(
          activeExtraction.isReasoning
            ? {
                type: "reasoning-delta",
                delta: prefix + text,
                id: `reasoning-${activeExtraction.idCounter}`,
              }
            : {
                type: "text-delta",
                delta: prefix + text,
                id: activeExtraction.textId,
              }
        );
      }

      function updateExtractionState(activeExtraction: ExtractionState) {
        activeExtraction.afterSwitch = false;
        if (activeExtraction.isReasoning) {
          activeExtraction.isFirstReasoning = false;
        } else {
          activeExtraction.isFirstText = false;
        }
      }

      function handleFullMatch(
        activeExtraction: ExtractionState,
        controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
        startIndex: number,
        nextTag: string
      ) {
        activeExtraction.buffer = activeExtraction.buffer.slice(
          startIndex + nextTag.length
        );

        if (activeExtraction.isReasoning) {
          controller.enqueue({
            type: "reasoning-end",
            id: `reasoning-${activeExtraction.idCounter}`,
          });
          activeExtraction.idCounter += 1;
        }

        activeExtraction.isReasoning = !activeExtraction.isReasoning;
        activeExtraction.afterSwitch = true;
      }

      function processTagMatch({
        activeExtraction,
        controller,
        publish,
        startIndex,
        nextTag,
      }: {
        activeExtraction: ExtractionState;
        controller: TransformStreamDefaultController<LanguageModelV3StreamPart>;
        publish: (text: string) => void;
        startIndex: number;
        nextTag: string;
      }): boolean {
        publish(activeExtraction.buffer.slice(0, startIndex));

        const foundFullMatch =
          startIndex + nextTag.length <= activeExtraction.buffer.length;

        if (foundFullMatch) {
          handleFullMatch(activeExtraction, controller, startIndex, nextTag);
          return true;
        }

        activeExtraction.buffer = activeExtraction.buffer.slice(startIndex);
        return false;
      }

      function processBuffer(
        activeExtraction: ExtractionState,
        controller: TransformStreamDefaultController<LanguageModelV3StreamPart>
      ) {
        const publish = createPublisher(activeExtraction, controller);
        let continueProcessing = true;

        while (continueProcessing) {
          const nextTag = activeExtraction.isReasoning
            ? closingTag
            : openingTag;
          const startIndex = getPotentialStartIndex(
            activeExtraction.buffer,
            nextTag
          );

          if (startIndex == null) {
            publish(activeExtraction.buffer);
            activeExtraction.buffer = "";
            break;
          }

          continueProcessing = processTagMatch({
            activeExtraction,
            controller,
            publish,
            startIndex,
            nextTag,
          });
        }
      }

      return {
        stream: stream.pipeThrough(
          new TransformStream<
            LanguageModelV3StreamPart,
            LanguageModelV3StreamPart
          >({
            transform: (chunk, controller) => {
              if (chunk.type !== "text-delta") {
                controller.enqueue(chunk);
                return;
              }

              if (reasoningExtractions[chunk.id] == null) {
                reasoningExtractions[chunk.id] = {
                  isFirstReasoning: true,
                  isFirstText: true,
                  afterSwitch: false,
                  isReasoning: startWithReasoning,
                  buffer: "",
                  idCounter: 0,
                  textId: chunk.id,
                };
              }

              const activeExtraction = reasoningExtractions[chunk.id];
              activeExtraction.buffer += chunk.delta;
              processBuffer(activeExtraction, controller);
            },
          })
        ),
        ...rest,
      };
    },
  };
}
