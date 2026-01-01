// opencode가 provider를 어떻게 로드하는지 시뮬레이션

// opencode.json의 tcm-xml provider 설정:
// {
//   "npm": "./provider.js",
//   "options": { "baseURL": "...", "apiKey": "..." }
// }

// opencode는 아마도:
// 1. npm 모듈을 import
// 2. default export 또는 특정 함수 호출
// 3. options 전달

import providerModule from "./provider.js";

console.log("1. Provider module type:", typeof providerModule);
console.log("2. Provider module keys:", Object.keys(providerModule));

// default export가 함수인 경우
if (typeof providerModule === "function") {
  console.log("\n3. Default export is a function, calling it with options...");
  const provider = providerModule({
    baseURL: "https://api.friendli.ai/serverless/v1",
    apiKey: process.env.FRIENDLI_TOKEN,
  });
  console.log("   Provider type:", typeof provider);
  console.log("   Provider keys:", Object.keys(provider));
}

// createXXX 패턴 확인
const createFn = providerModule.createFriendliGlmXml || providerModule.default;
if (typeof createFn === "function") {
  console.log("\n4. Found create function, calling it...");
  const provider = createFn({
    baseURL: "https://api.friendli.ai/serverless/v1",
    apiKey: process.env.FRIENDLI_TOKEN,
  });
  console.log("   Provider type:", typeof provider);
  console.log("   Has languageModel:", typeof provider.languageModel);
}
