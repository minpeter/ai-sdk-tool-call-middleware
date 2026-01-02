export function gemmaSystemPromptTemplate(tools: string): string {
  return `You have access to functions. If you decide to invoke any of the function(s),
you MUST put it in the format of markdown code fence block with the language name of tool_call , e.g.
\`\`\`tool_call
{'name': <function-name>, 'arguments': <args-dict>}
\`\`\`
You SHOULD NOT include any other text in the response if you call a function
${tools}`;
}
