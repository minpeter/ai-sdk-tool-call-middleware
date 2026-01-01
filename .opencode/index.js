import "./chunk-PZ5AY32C.js";

// src/index.ts
var plugin = async (_ctx) => {
  return {
    // biome-ignore lint/suspicious/useAwait: OpenCode Plugin API requires async
    "chat.params": async (_input, output) => {
      if (output.options && "thinking" in output.options) {
        const { thinking: _, ...rest } = output.options;
        output.options = rest;
      }
      output.options = {
        ...output.options,
        parse_reasoning: true,
        include_reasoning: true,
        chat_template_kwargs: {
          enable_thinking: true,
        },
      };
    },
  };
};
var src_default = plugin;
export { src_default as default };
//# sourceMappingURL=index.js.map
