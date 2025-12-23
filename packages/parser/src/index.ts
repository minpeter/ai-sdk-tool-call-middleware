import { jsonMixProtocol } from "./protocols/json-mix-protocol";
import { morphXmlProtocol } from "./protocols/morph-xml-protocol";
import { createToolMiddleware } from "./tool-call-middleware";

const gemmaToolMiddleware = createToolMiddleware({
  protocol: jsonMixProtocol(
    // Customize the tool call delimiters to use markdown code fences
    {
      toolCallStart: "```tool_call\n",
      // TODO: Support specifying multiple possible tags,
      // e.g., for gemma, it would be nice to be able to set both `` and ``` at the same time.
      toolCallEnd: "\n```",
      toolResponseStart: "```tool_response\n",
      toolResponseEnd: "\n```",
    }
  ),
  toolSystemPromptTemplate(tools) {
    return `You have access to functions. If you decide to invoke any of the function(s),
you MUST put it in the format of markdown code fence block with the language name of tool_call , e.g.
\`\`\`tool_call
{'name': <function-name>, 'arguments': <args-dict>}
\`\`\`
You SHOULD NOT include any other text in the response if you call a function
${tools}`;
  },
});

const hermesToolMiddleware = createToolMiddleware({
  protocol: jsonMixProtocol,
  toolSystemPromptTemplate(tools) {
    return `You are a function calling AI model.
You are provided with function signatures within <tools></tools> XML tags.
You may call one or more functions to assist with the user query.
Don't make assumptions about what values to plug into functions.
Here are the available tools: <tools>${tools}</tools>
Use the following pydantic model json schema for each tool call you will make: {"title": "FunctionCall", "type": "object", "properties": {"arguments": {"title": "Arguments", "type": "object"}, "name": {"title": "Name", "type": "string"}}, "required": ["arguments", "name"]}
For each function call return a json object with function name and arguments within <tool_call></tool_call> XML tags as follows:
<tool_call>
{"name": "<function-name>", "arguments": <args-dict>}
</tool_call>`;
  },
});

const morphXmlToolMiddleware = createToolMiddleware({
  protocol: morphXmlProtocol,
  placement: "last",
  toolSystemPromptTemplate(tools: string) {
    return `You are a function calling AI model.

Available functions are listed inside <tools></tools>.
<tools>${tools}</tools>

# Rules
- Use exactly one XML element whose tag name is the function name.
- Put each parameter as a child element.
- Values must follow the schema exactly (numbers, arrays, objects, enums → copy as-is).
- Do not add or remove functions or parameters.
- Each required parameter must appear once.
- Output nothing before or after the function call.

# Example
<get_weather>
  <location>New York</location>
  <unit>celsius</unit>
</get_weather>`;
  },
});

// biome-ignore lint/performance/noBarrelFile: Package entrypoint - must re-export for public API
export { jsonMixProtocol } from "./protocols/json-mix-protocol";
export { morphXmlProtocol } from "./protocols/morph-xml-protocol";
export { createToolMiddleware } from "./tool-call-middleware";
export { gemmaToolMiddleware, hermesToolMiddleware, morphXmlToolMiddleware };

export {
  getDebugLevel,
  logParsedChunk,
  logParsedSummary,
  logParseFailure,
  logRawChunk,
} from "./utils/debug";
// Export utilities
export { createDynamicIfThenElseSchema } from "./utils/dynamic-tool-schema";
export { getPotentialStartIndex } from "./utils/get-potential-start-index";
export type { OnErrorFn } from "./utils/on-error";
export { extractOnErrorOption } from "./utils/on-error";
export type { ToolCallMiddlewareProviderOptions } from "./utils/provider-options";
export {
  decodeOriginalTools,
  encodeOriginalTools,
  extractToolNamesFromOriginalTools,
  isToolChoiceActive,
  originalToolsSchema,
} from "./utils/provider-options";
export { escapeRegExp } from "./utils/regex";
export type { ParseOptions as RJSONParseOptions } from "./utils/robust-json";
export * as RJSON from "./utils/robust-json";
export {
  parse as parseRJSON,
  stringify as stringifyRJSON,
  transform as transformRJSON,
} from "./utils/robust-json";
export {
  hasInputProperty,
  isToolCallContent,
  isToolResultPart,
} from "./utils/type-guards";
