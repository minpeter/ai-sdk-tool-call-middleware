import { Template } from "@huggingface/jinja";
import { downloadFile } from "@huggingface/hub";

async function main() {
  const modelConfig: any = await downloadFile({
    repo: "minpeter/LoRA-Llama-3b-v1-iteration-00-sf-xlam-09",
    path: "tokenizer_config.json",
  });

  if (modelConfig === null) {
    throw new Error("Failed to download tokenizer_config.json");
  }

  const config = JSON.parse(await (modelConfig as Blob).text());

  const chat = [
    { role: "user", content: "Hello, how are you?" },
    {
      role: "assistant",
      content: "I'm doing great. How can I help you today?",
    },
    {
      role: "user",
      content: "I'd like to show off how chat templating works!",
    },
    {
      role: "assistant",
      content: "I'm doing great. How can I help you today?",
    },
  ];

  let chatTemplateStr = config.chat_template;

  if (typeof config.chat_template !== "string") {
    if (
      Array.isArray(config.chat_template) &&
      config.chat_template[0]?.name === "default" &&
      typeof config.chat_template[0]?.template === "string"
    ) {
      chatTemplateStr = config.chat_template[0].template;
    } else {
      console.log(config.chat_template);
      throw new Error("chat_template is not a string");
    }
  }

  const template = new Template(chatTemplateStr);
  const result = template.render({
    messages: chat,
    bos_token: config.bos_token,
    eos_token: config.eos_token,
    add_generation_prompt: true,
    // continue_final_message: true,
  });
  console.log(result);
}

main();
