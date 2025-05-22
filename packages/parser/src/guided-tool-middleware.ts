import type {
  LanguageModelV2Prompt,
  LanguageModelV2Middleware,
  LanguageModelV2,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";
import { chatTemplate, getPotentialStartIndex, RJSON } from "./utils";
import { convertToolPrompt } from "./utils/conv-tool-prompt";

export function createGuidedToolMiddleware({
  toolCallTag,
  toolCallEndTag,
  toolResponseTag,
  toolResponseEndTag,
  toolSystemPromptTemplate,
  guidedGeneration: { completionModel, renderTemplateHfModel },
}: {
  toolCallTag: string;
  toolCallEndTag: string;
  toolResponseTag: string;
  toolResponseEndTag: string;
  toolSystemPromptTemplate: (tools: string) => string;
  guidedGeneration: {
    completionModel: LanguageModelV2; // The model to use for guided generation
    renderTemplateHfModel: string; // The Hugging Face model ID for prefill chat template rendering
  };
}): LanguageModelV2Middleware {
  return {
    middlewareVersion: "v2",
    wrapGenerate: async ({ doGenerate, model, params }) => {
      const result = await doGenerate();

      // Handle case: finishReason is not "stop"
      if (result.finishReason !== "stop") {
        return result; // No tool call detected, return as is
      }

      // TODO: 멈춘 이유가 stop이라면
      // 가이드된 생성을 트리거함

      console.log(params.prompt);

      const messages = convertToolPrompt({
        paramsPrompt: params.prompt,
        paramsTools: params.tools,
        toolSystemPromptTemplate,
        toolCallTag,
        toolCallEndTag,
        toolResponseTag,
        toolResponseEndTag,
      });

      const prefillPrompt = `${toolCallTag}\n{"name": `;

      const prefillMessages = [
        ...messages,
        {
          role: "assistant" as const,
          content: [
            {
              type: "text" as const,
              text: prefillPrompt,
            },
          ],
        },
      ];

      const tmpl = await chatTemplate.create({ model: renderTemplateHfModel });
      const prompt = tmpl.render({ messages: prefillMessages, prefill: true });

      console.log("prompt", prompt);

      return {
        ...result,
      };
      // const toolCallRegex = new RegExp(
      //   `${toolCallTag}(.*?)(?:${toolCallEndTag}|$)`,
      //   "gs"
      // );

      // // Process each content item using flatMap
      // const newContent = result.content.flatMap(
      //   (contentItem): LanguageModelV2Content[] => {
      //     // Keep non-text items or text items without the tool call tag as they are.
      //     if (
      //       contentItem.type !== "text" ||
      //       !contentItem.text.includes(toolCallTag)
      //     ) {
      //       return [contentItem]; // Return as an array for flatMap
      //     }

      //     const text = contentItem.text;
      //     const processedElements: LanguageModelV2Content[] = [];
      //     let currentIndex = 0;
      //     let match;

      //     // --- Nested Tool Call Parsing Logic ---
      //     const parseAndCreateToolCall = (
      //       toolCallJson: string
      //     ): LanguageModelV2ToolCall | null => {
      //       try {
      //         const parsedToolCall = RJSON.parse(toolCallJson) as {
      //           name: string;
      //           arguments: unknown; // Use unknown for initial parsing flexibility
      //         };

      //         if (
      //           !parsedToolCall ||
      //           typeof parsedToolCall.name !== "string" ||
      //           typeof parsedToolCall.arguments === "undefined"
      //         ) {
      //           console.error(
      //             "Failed to parse tool call: Invalid structure",
      //             toolCallJson
      //           );
      //           return null;
      //         }

      //         return {
      //           type: "tool-call",
      //           toolCallType: "function",
      //           toolCallId: generateId(),
      //           toolName: parsedToolCall.name,
      //           // Ensure args is always a JSON string
      //           args:
      //             typeof parsedToolCall.arguments === "string"
      //               ? parsedToolCall.arguments
      //               : JSON.stringify(parsedToolCall.arguments),
      //         };
      //       } catch (error) {
      //         console.error(
      //           "Failed to parse tool call JSON:",
      //           error,
      //           "JSON:",
      //           toolCallJson
      //         );
      //         return null; // Indicate failure
      //       }
      //     };
      //     // --- End of Nested Logic ---

      //     // Use regex.exec in a loop to find all matches and indices
      //     while ((match = toolCallRegex.exec(text)) !== null) {
      //       const startIndex = match.index;
      //       const endIndex = startIndex + match[0].length;
      //       const toolCallJson = match[1]; // Captured group 1: the JSON content

      //       // 1. Add text segment *before* the match
      //       if (startIndex > currentIndex) {
      //         const textSegment = text.substring(currentIndex, startIndex);
      //         // Add only if it contains non-whitespace characters
      //         if (textSegment.trim()) {
      //           processedElements.push({ type: "text", text: textSegment });
      //         }
      //       }

      //       // 2. Parse and add the tool call
      //       if (toolCallJson) {
      //         const toolCallObject = parseAndCreateToolCall(toolCallJson);
      //         if (toolCallObject) {
      //           processedElements.push(toolCallObject);
      //         } else {
      //           // Handle parsing failure: Option 1: Log and add original match as text
      //           console.warn(
      //             `Could not process tool call, keeping original text: ${match[0]}`
      //           );
      //           processedElements.push({ type: "text", text: match[0] });
      //           // Option 2: Log and discard (do nothing here)
      //           // Option 3: Create a specific error content part if supported
      //         }
      //       }

      //       // 3. Update index for the next search
      //       currentIndex = endIndex;

      //       // Reset lastIndex if using exec with 'g' flag in a loop (though typically not needed if loop condition is `match !== null`)
      //       // toolCallRegex.lastIndex = currentIndex;
      //     }

      //     // 4. Add any remaining text *after* the last match
      //     if (currentIndex < text.length) {
      //       const remainingText = text.substring(currentIndex);
      //       // Add only if it contains non-whitespace characters
      //       if (remainingText.trim()) {
      //         processedElements.push({ type: "text", text: remainingText });
      //       }
      //     }

      //     // Return the array of processed parts, replacing the original text item
      //     return processedElements;
      //   }
      // );

      // // Return the result with the potentially modified content array
      // return {
      //   ...result,
      //   content: newContent,
      // };
    },

    transformParams: async ({ params }) => {
      const toolSystemPrompt = convertToolPrompt({
        paramsPrompt: params.prompt,
        paramsTools: params.tools,
        toolSystemPromptTemplate,
        toolCallTag,
        toolCallEndTag,
        toolResponseTag,
        toolResponseEndTag,
      });

      // Warn if the user has set stopSequences
      if (params.stopSequences) {
        console.warn(
          "stopSequences is not supported with guided generation. Ignoring user-supplied stopSequences."
        );

        console.warn(
          "The following stopSequences will be ignored:",
          params.stopSequences
        );
      }

      return {
        ...params,
        prompt: toolSystemPrompt,

        // set the mode back to regular and remove the default tools.
        tools: [],
        toolChoice: undefined,
        // Make it stop when starting with toolCallTag for guided creation
        // WARNING: Incompatible with user-supplied stopSequences
        // Override user input because we need to use the finishReason "stop" as a tool call detection.
        stopSequences: [toolCallTag],
      };
    },
  };
}
