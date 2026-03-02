import { createStagePilotEngineFromEnv } from "../stagepilot/orchestrator";

async function main() {
  const engine = createStagePilotEngineFromEnv();

  const result = await engine.run({
    caseId: "demo-001",
    district: "Gangbuk-gu",
    notes: "Missed rent payment and unstable meal access.",
    risks: ["housing", "food", "income"],
    urgencyHint: "high",
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
