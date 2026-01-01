import type { Plugin } from "@opencode-ai/plugin";

// biome-ignore lint/suspicious/useAwait: OpenCode Plugin API requires async
const plugin: Plugin = async (_ctx) => {
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

export default plugin;
