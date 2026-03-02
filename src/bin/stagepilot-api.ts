import { createStagePilotApiServer } from "../api/stagepilot-server";

function readPort(): number {
  const value = Number.parseInt(process.env.PORT ?? "8080", 10);
  if (Number.isNaN(value) || value < 1 || value > 65_535) {
    return 8080;
  }
  return value;
}

const port = readPort();
const server = createStagePilotApiServer();

server.listen(port, "0.0.0.0", () => {
  const service = process.env.SERVICE_NAME_API ?? "stagepilot-api";
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-pro";
  console.info(
    `[stagepilot-api] listening on 0.0.0.0:${port} service=${service} model=${model} gpu=false`
  );
});

function shutdown(signal: NodeJS.Signals) {
  console.info(`[stagepilot-api] received ${signal}, shutting down`);
  server.close((error) => {
    if (error) {
      console.error("[stagepilot-api] shutdown error", error);
      process.exitCode = 1;
      return;
    }
    process.exitCode = 0;
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
