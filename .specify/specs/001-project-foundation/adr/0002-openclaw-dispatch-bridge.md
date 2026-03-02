# ADR 0002 — OpenClaw Dispatch Bridge for Operator Messaging

## Status
Accepted — 2026-02-28

## Context
StagePilot already generates execution-ready plans (`/v1/plan`), ontology insights (`/v1/insights`), and operational simulations (`/v1/whatif`).  
For real operations flow, case workers need a direct way to push briefings into messaging channels used by public operators (e.g. Telegram/Google Chat) without leaving the console.

We need:
- minimal implementation risk during hackathon,
- CPU-only compatibility,
- optional integration (service must still run when OpenClaw is not configured).

## Decision
- Add an OpenClaw dispatch bridge at `src/stagepilot/openclaw.ts`.
- Add API route `POST /v1/notify` that:
  - validates intake + optional twin inputs,
  - runs orchestration,
  - builds a compact operator briefing message,
  - dispatches through OpenClaw.
- Support two delivery modes:
  - webhook mode via `OPENCLAW_WEBHOOK_URL`,
  - CLI mode via `OPENCLAW_CMD` (default `openclaw`).
- Keep safe test mode with `delivery.dryRun=true`.
- Keep integration optional with `OPENCLAW_ENABLED=0` default.

## Consequences
- Operators can receive briefing messages directly from StagePilot flows.
- Service remains deployable in environments without OpenClaw (returns explicit non-delivery status instead of crashing).
- Added configuration surface (`OPENCLAW_*`) and one new endpoint to test and monitor.
- Future production hardening can layer auth/allowlist over `/v1/notify` without changing orchestration core.
