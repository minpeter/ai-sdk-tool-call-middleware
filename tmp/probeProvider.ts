(async function () {
  try {
    const mod = await import("@ai-sdk/openai");
    const provider = mod.openai("gpt-4.1");
    console.log("Provider top-level keys:", Object.keys(provider));
    console.log(
      "Provider prototype keys:",
      Object.getOwnPropertyNames(Object.getPrototypeOf(provider))
    );
    // Try typeof various known methods
    const methods = [
      "call",
      "generate",
      "createChatCompletion",
      "chat",
      "request",
      "complete",
      "createCompletion",
      "completion",
      "chat.completions",
    ];
    for (const m of methods) {
      const exists = m.includes(".")
        ? m.split(".").reduce((acc, k) => acc && acc[k], provider as any)
        : (provider as any)[m];
      console.log(`${m}:`, typeof exists, !!exists);
    }
  } catch (e) {
    console.error("probe failed", e);
    process.exit(1);
  }
})();
