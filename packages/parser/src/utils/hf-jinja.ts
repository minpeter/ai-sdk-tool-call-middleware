import { Template } from "@huggingface/jinja";
import { downloadFile } from "@huggingface/hub";
import { LanguageModelV2Prompt } from "@ai-sdk/provider";
import { env } from "process";

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
  public static async create({
    model,
    hfToken,
  }: {
    model: string;
    hfToken?: string;
  }): Promise<chatTemplate> {
    const instance = new chatTemplate(model, hfToken ?? env.HF_TOKEN);
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
    messages: LanguageModelV2Prompt;
    prefill?: boolean;
  }): string {
    if (!this.chatTemplateStr || !this.config) {
      throw new Error("chatTemplate is not initialized. Call init() first.");
    }

    // LanguageModelV2Prompt can have various roles such as system, user, assistant, etc.
    // Since the chat_template may support the system role as well, do not restrict the role and only process the content correctly.
    const processedMessages: Array<{
      role: string;
      content: string;
    }> = messages.map((message) => {
      // Pass the role as is (system, user, assistant, etc.)
      return {
        role: message.role,
        content: Array.isArray(message.content)
          ? message.content
              .map((content: any) => {
                if (typeof content === "string") {
                  return content;
                } else if (
                  content.type === "text" &&
                  typeof content.text === "string"
                ) {
                  return content.text;
                } else {
                  throw new Error(
                    `Invalid content type: ${JSON.stringify(content)}`
                  );
                }
              })
              .join("")
          : typeof message.content === "string"
            ? message.content
            : (() => {
                throw new Error(
                  `Invalid message.content type: ${JSON.stringify(message.content)}`
                );
              })(),
      };
    });

    const template = new Template(this.chatTemplateStr);
    const result = template.render({
      messages: processedMessages,
      bos_token: this.config.bos_token,
      eos_token: this.config.eos_token,
      continue_final_message: prefill,
    });
    // If prefill (continue_final_message) is true, truncate the result after the last message content
    let finalResult = result;
    if (prefill) {
      const finalMessage = messages[messages.length - 1].content;
      let finalMessageText = "";
      if (typeof finalMessage === "string") {
        finalMessageText = finalMessage;
      } else if (Array.isArray(finalMessage)) {
        finalMessageText = finalMessage
          .map((content) => {
            if (typeof content === "string") {
              return content;
            } else if (
              content.type === "text" &&
              typeof content.text === "string"
            ) {
              return content.text;
            } else {
              throw new Error(
                `Invalid content type in last message: ${JSON.stringify(content)}`
              );
            }
          })
          .join("");
      }
      if (finalMessageText.trim().length > 0) {
        const idx = result.lastIndexOf(finalMessageText.trim());
        if (idx === -1) {
          throw new Error(
            "continue_final_message is true but the last message does not appear in the rendered result!"
          );
        }
        // Preserve whitespace if possible
        if (
          result.slice(idx, idx + finalMessageText.length) === finalMessageText
        ) {
          finalResult = result.slice(0, idx + finalMessageText.length);
        } else {
          finalResult = result.slice(0, idx + finalMessageText.trim().length);
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
  const messages: LanguageModelV2Prompt = [
    { role: "user", content: [{ type: "text", text: "Hello, how are you?" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I'm doing great. How can I help you today?" },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "I'd like to show off how chat templating works!",
        },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "PREFILLED:TESTING" }],
    },
  ];
  const model = "Qwen/Qwen2.5-7B";

  const tmpl = await chatTemplate.create({
    model: model,
    // hfToken: "FILL_IN_YOUR_HUGGINGFACE_TOKEN",
  });

  const prompt = tmpl.render({ messages, prefill: true });
  console.log("\n===== Rendered Prompt =====\n");
  console.log(prompt);
}

if (require.main === module) {
  main();
}
