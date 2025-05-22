import { Template } from "@huggingface/jinja";
import { downloadFile } from "@huggingface/hub";

/**
 * chatTemplate class: Initialize with model and (optionally) HuggingFace token, then render prompts with messages.
 * This class is instantiated using the static factory method `create()`.
 */
export class chatTemplate {
  private chatTemplateStr: string | undefined;
  private config: any;

  /**
   * Private constructor. Use chatTemplate.create() for instantiation.
   */
  private constructor(
    private model: string,
    private hfToken?: string
  ) {}

  /**
   * Loads the chat template and config from the model repo.
   */
  private async init() {
    const modelConfig: any = await downloadFile({
      repo: this.model,
      path: "tokenizer_config.json",
      accessToken: this.hfToken,
    });
    if (modelConfig === null) {
      throw new Error("Failed to download tokenizer_config.json");
    }
    this.config = JSON.parse(await (modelConfig as Blob).text());
    if (typeof this.config.chat_template === "string") {
      this.chatTemplateStr = this.config.chat_template;
    } else if (
      Array.isArray(this.config.chat_template) &&
      this.config.chat_template[0]?.name === "default" &&
      typeof this.config.chat_template[0]?.template === "string"
    ) {
      this.chatTemplateStr = this.config.chat_template[0].template;
    } else {
      console.log(this.config.chat_template);
      throw new Error("chat_template is not a string");
    }
  }

  /**
   * Creates and initializes a new chatTemplate instance.
   * @param model The model name.
   * @param hfToken Optional HuggingFace token.
   * @returns A Promise that resolves to an initialized chatTemplate instance.
   */
  public static async create(
    model: string,
    hfToken?: string
  ): Promise<chatTemplate> {
    const instance = new chatTemplate(model, hfToken);
    await instance.init();
    return instance;
  }

  /**
   * Render the prompt from messages.
   * @param messages Array of chat messages (role, content)
   * @param prefill Whether to prefill (continue_final_message) the last message (default: false)
   * @returns Rendered prompt string
   */
  render({
    messages,
    prefill = false,
  }: {
    messages: Array<{ role: string; content: string }>;
    prefill?: boolean;
  }): string {
    if (!this.chatTemplateStr || !this.config) {
      throw new Error("chattemplate is not initialized. Call init() first.");
    }
    const template = new Template(this.chatTemplateStr);
    const result = template.render({
      messages,
      bos_token: this.config.bos_token,
      eos_token: this.config.eos_token,
      continue_final_message: prefill,
    });
    // If prefill (continue_final_message) is true, truncate the result after the last message content
    let finalResult = result;
    if (prefill) {
      const finalMessage = messages[messages.length - 1].content;
      if (typeof finalMessage === "string" && finalMessage.trim().length > 0) {
        const idx = result.lastIndexOf(finalMessage.trim());
        if (idx === -1) {
          throw new Error(
            "continue_final_message is true but the last message does not appear in the rendered result!"
          );
        }
        // Preserve whitespace if possible
        if (result.slice(idx, idx + finalMessage.length) === finalMessage) {
          finalResult = result.slice(0, idx + finalMessage.length);
        } else {
          finalResult = result.slice(0, idx + finalMessage.trim().length);
        }
      } else {
        throw new Error("Last message content is empty or not a string");
      }
    }
    return finalResult;
  }
}

// Example usage (main function)
async function main() {
  const messages = [
    { role: "user", content: "Hello, how are you?" },
    {
      role: "assistant",
      content: "I'm doing great. How can I help you today?",
    },
    {
      role: "user",
      content: "I'd like to show off how chat templating works!",
    },
    { role: "assistant", content: "PREFILLED:TESTING" },
  ];
  const model = "Qwen/Qwen2.5-7B";

  const tmpl = await chatTemplate.create(model /*, hfToken */);
  const prompt = tmpl.render({ messages, prefill: true });
  console.log("\n===== Rendered Prompt =====\n");
  console.log(prompt);
}

if (require.main === module) {
  main();
}
