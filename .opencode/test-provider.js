import { createFriendliGlmXml } from "./provider.js";

const provider = createFriendliGlmXml({
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
});

console.log("Provider created successfully");
console.log("languageModel:", typeof provider.languageModel);

const model = provider.languageModel("zai-org/GLM-4.6");
console.log("Model created:", model.modelId);
