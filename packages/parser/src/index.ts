import { defaultTemplate, createToolMiddleware } from "./tool-call-middleware";

const gemmaToolMiddleware = createToolMiddleware({
  toolSystemPromptTemplate(tools) {
    return `You have access to functions. If you decide to invoke any of the function(s),
  you MUST put it in the format of
  \`\`\`tool_call
  {'name': <function-name>, 'arguments': <args-dict>}
  \`\`\`
  You SHOULD NOT include any other text in the response if you call a function
  ${tools}`;
  },
  toolCallTag: "```tool_call\n",
  toolCallEndTag: "```",
  toolResponseTag: "```tool_response\n",
  toolResponseEndTag: "\n```",
});

const hermesToolMiddleware = createToolMiddleware({});

export {
  defaultTemplate,
  gemmaToolMiddleware,
  hermesToolMiddleware,
  createToolMiddleware,
};
