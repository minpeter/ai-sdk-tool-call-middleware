# GLM‑5.2 Native‑Plus 도구 호출 재검증

> **폐기된 역사 자료 (2026-07-19):** 이 보고서의 Native‑Plus/native-primary
> 제품 경로는 제거됐다. 아래 수치와 결론은 당시 구현의 재현 증거로만 보존하며,
> 현재 prompt-only `glm5ToolMiddleware`의 성능이나 구조를 설명하지 않는다.

작성일: 2026-07-17 (Asia/Seoul)

## Executive Summary

`zai-org/glm-5.2`를 `https://freerouter.minpeter.workers.dev/v1`에서 provider-native tool calling과 새 **Native‑Plus (hybrid, repair-only)** 경로로 짝지어 검증했다. Native‑Plus는 별도 text protocol이 아니다. Provider Native의 구조화 호출을 우선 보존하고, 안전하게 판정할 수 있는 손상만 제한적으로 복구하며, Native 호출이 전혀 없을 때만 GLM canonical XML 또는 응답 전체에 고정된 bare `tool(key=value)` 호출을 fallback으로 해석한다.

결론은 다음과 같다.

1. **Native‑Plus가 Native를 일관되게 이겼다는 증거는 나오지 않았다.** BFCL은 376/456 대 376/456로 동률, ACE는 82/100 대 Native 84/100, MCPMark Easy는 8/10 대 Native 7/10이었다. Exact paired McNemar p는 각각 1.0, 0.625, 1.0이다.
2. **이번 full snapshot에서는 Native‑Plus가 실제로 개입한 응답이 0건이었다.** Native‑Plus arm의 provider bytes를 plain Native와 Native‑Plus 양쪽에 재생했을 때 BFCL 456, ACE 100, MCPMark 55 turn 모두 call/text가 동일했다. 따라서 full score 차이는 byte-identical 요청을 반복 실행할 때의 serving 비결정성이다.
3. **복구 경로 자체는 과거 Native 캡처에서 실효성이 있었다.** 별도 offline replay에서 BFCL 380→382/456, ACE 81→83/100으로 각각 2건을 복구했고 기존 정답 손실은 없었다. 다만 희소한 malformed 출력이 이번 full snapshot에는 발생하지 않았다.
4. **스트리밍 무결성은 검증됐다.** BFCL 26개 실제 SSE response와 MCPMark 대표 3개 작업의 41개 multi-turn SSE response에서 live↔replay call/text가 전부 일치했다. Native‑Plus 응답/turn은 각각 9개 raw SSE byte 분할과 9개 내부 delta 분할에서 chunk-invariant였다.
5. **운영 판단은 Native 기본 + Native‑Plus opt-in safety net이다.** 이 endpoint에서 Native‑Plus를 성능 향상 레이어로 홍보할 근거는 없다. 다만 request-identical repair-only 경로로서 희소한 손상 복구와 text fallback을 제공하며, parser/stream security gate를 통과했다.

## 연구 범위

### 이번 Native‑Plus 연구

| 단계 | 범위 | Jobs |
|---|---|---:|
| Steering dev | BFCL 30×3을 두 fingerprint에서 실행, ACE 40×3, MCPMark 3×3 | 309 |
| Full generate | BFCL 456×2, ACE 100×2, MCPMark Easy 10×2 | 1,132 |
| Live SSE | BFCL 13×2, MCPMark 대표 3×2 | 32 |
| **합계** | 유효 분석 job; MCPMark job은 multi-turn | **1,473** |

도중 잘못된 환경 변수로 시작했다가 즉시 중단한 MCPMark 4개 부분 job은 분석에서 제외했다. 기존 Native+7 middleware 및 GLM Canonical 연구 5,686 jobs와 합치면, 이 저장소에 보존된 본 연구 계열의 유효 분석 규모는 7,159 jobs다.

### 고정 데이터셋

| Suite | Pin | 범위 |
|---|---|---|
| BFCL | `6ea57973c7a6097fd7c5915698c54c17c5b1b6c8` | 13 single-turn/static/live category, 456 cases/arm |
| ACEBench | `56dd66cf6439b0d9655ee1b353e4cd745c6f664e` | Normal EN/ZH, 10 category×5 cases/language, 100 cases/arm |
| MCPMark | `cd45b7f57923b9b3985467f5139927575f83141c` | Filesystem Easy 10-task adapted loop |

세 suite 모두 protocol comparison panel이며 공식 leaderboard submission이 아니다.

## Native‑Plus 설계

```text
provider-native tools/history 유지
              │
              ▼
      Native 구조화 호출 존재? ── yes ──► Native 우선
              │ no                         │
              ▼                            ▼
 canonical XML / anchored bare fallback   bounded argument repair
              │                            │
              └──────────────┬─────────────┘
                             ▼
                    AI SDK tool lifecycle
```

### 안전 경계

- Native call이 있으면 text fallback call은 억제한다.
- JSONish bare scalar 및 마지막 `}`/`]` 하나 누락만 제한적으로 복구한다.
- 100 KiB argument/bare-call cap, 최대 중첩 256, 최대 named argument 1,024를 적용한다.
- duplicate argument, undeclared tool, prototype-sensitive key, truncated bare call은 fail-closed다.
- provider-executed tool은 schema coercion 없이 그대로 보존한다.
- stream은 repaired call과 이미 방출한 delta가 불일치하지 않도록 Native lifecycle을 확정 시점까지 조정한다.

## Steering 선택: repair-only 동결

Balanced action steering 문구를 넣는 arm과 request-identical repair-only arm을 seed 917 dev panel에서 비교했다.

| Dev panel | Native | Repair-only | Action steering + repair |
|---|---:|---:|---:|
| BFCL 30, 최종 fingerprint | 25/30 | 25/30 | 25/30 |
| ACE 40 | 34/40 | 34/40 | 33/40 |
| MCPMark 대표 3 | 2/3 | 3/3 | 3/3 |

BFCL에서는 이득이 없고 ACE에서는 1건 낮았으며, MCPMark에서는 성공률이 같지만 repair-only가 action steering보다 p50 latency와 token footprint가 작았다. 따라서 full run 전에 `createGlm5NativePlusMiddleware()`와 `glm5NativePlusToolMiddleware`의 기본값을 repair-only로 동결했다. Steering은 `steeringPrompt: true` 명시 opt-in으로만 남겼다.

## Full Generate 결과

| Suite | Native | Native‑Plus | Δ | Plus win/loss | Exact McNemar p |
|---|---:|---:|---:|---:|---:|
| BFCL v4 derived, n=456 | 376/456 (82.5%) | 376/456 (82.5%) | 0.0%p | 9/9 | 1.0 |
| ACE Normal derived, n=100 | **84/100 (84%)** | 82/100 (82%) | -2.0%p | 1/3 | 0.625 |
| MCPMark Filesystem Easy, n=10 | 7/10 (70%) | **8/10 (80%)** | +10.0%p | 1/0 | 1.0 |

Suite마다 task, scorer, sample size가 다르므로 pooled accuracy는 계산하지 않았다. 특히 MCPMark n=10의 10%p는 task 1개이며 confidence interval이 넓다.

### BFCL

| Metric | Native | Native‑Plus |
|---|---:|---:|
| End-to-end strict | 82.46% | 82.46% |
| Category macro | 82.24% | 81.83% |
| p50 / p95 latency | 2.617s / 6.716s | 2.635s / 7.018s |
| Mean input / output tokens | 482.4 / 141.6 | 481.4 / 142.9 |
| Provider/parser/leak errors | 0 / 0 / 0 | 0 / 0 / 0 |

Paired discordance는 18건으로 정확히 9 loss / 9 recovery였다. Native‑Plus failure는 wrong value 27, unexpected call 17, other semantic 15, missing call 9 순이었다.

### ACEBench-derived Normal

| Metric | Native | Native‑Plus |
|---|---:|---:|
| End-to-end strict | 84% | 82% |
| English | 42/50 | 40/50 |
| Chinese | 42/50 | 42/50 |
| p50 / p95 latency | 2.597s / 5.128s | 2.903s / 5.766s |
| Mean input / output tokens | 1,004.8 / 145.9 | 1,013.0 / 152.1 |
| Parser/leak/boundary whitespace | 0/0/0 | 0/0/0 |

Native‑Plus의 2건 순손실은 영어에 집중됐지만 paired discordance가 4건뿐이고 p=0.625다.

### MCPMark Filesystem Easy

| Metric | Native | Native‑Plus |
|---|---:|---:|
| Official verifier pass | 7/10 | 8/10 |
| Turns / tool calls | 55 / 57 | 55 / 54 |
| p50 / p95 job latency | 29.46s / 49.95s | 24.50s / 57.72s |
| Total tokens | 395,746 | 376,274 |
| Tokens/job | 39,574.6 | 37,627.4 |

두 arm 모두 `file_splitting`, `papers_counting`에 실패했고, Native‑Plus만 `structure_analysis`를 통과했다. 이 1건 회복은 middleware intervention이 아니라 반복 inference의 trajectory 차이였다.

## Request Parity와 Intervention Audit

### Request byte parity

| Scope | Paired request bodies | Byte-identical | Different |
|---|---:|---:|---:|
| BFCL | 456 | 456 | 0 |
| ACE | 100 | 100 | 0 |
| MCPMark first turn | 10 | 10 | 0 |

Repair-only Native‑Plus는 provider request를 바꾸지 않았다. MCPMark 후속 turn은 앞선 모델 trajectory와 tool result가 달라질 수 있어 first turn만 request parity 대상으로 삼았다.

### 실제 middleware intervention

Native‑Plus arm의 동일 provider response bytes를 plain Native와 production Native‑Plus 경로에 재생했다.

| Suite | Captures/turns | Calls changed | Text changed |
|---|---:|---:|---:|
| BFCL | 456 | 0 | 0 |
| ACE | 100 | 0 | 0 |
| MCPMark | 55 | 0 | 0 |

따라서 full score 차이를 Native‑Plus 효과로 귀속하면 안 된다. 반면 이전 Native capture snapshot offline replay에서는 bounded repair가 BFCL +2, ACE +2였고 기존 정답 손실은 없었다. Native‑Plus의 기대 가치는 평균 점수 상승보다 희소한 malformed response의 tail-risk 완화에 가깝다.

## 실제 SSE 및 Chunk Invariance

### BFCL 13-category panel

| Metric | Result |
|---|---:|
| Live jobs / SSE captures | 26 / 26 |
| Native / Native‑Plus strict | 12/13 / 12/13 |
| Live↔replay normalized calls | 26/26 exact |
| Live↔replay text | 26/26 exact |
| Native‑Plus chunk-invariant responses | 13/13 |
| Rechunk variants | response당 raw SSE byte 9 × stream delta 9 |
| Parser errors | 0 |
| Independent replay SHA-256 | `96249db315aeebc88a0ff8257af4aeea8f5b34467c1b93c37c0e26bcb35a0280` |

### MCPMark representative multi-turn panel

`largest_rename`, `uppercase`, `file_reorganize`를 실제 stream transport로 실행했다.

| Metric | Result |
|---|---:|
| Verifier pass | Native 3/3, Native‑Plus 3/3 |
| SSE turn captures | 41 |
| Live↔replay normalized calls/text | 41/41 exact |
| Native‑Plus chunk-invariant turns | 20/20 |
| Rechunk variants | turn당 raw SSE byte 9 × stream delta 9 |
| Parser errors | 0 |

## 기존 All‑Protocol Context

같은 날짜에 완료한 이전 8-arm baseline과 GLM Canonical addendum의 관측치는 다음과 같다. 이 표는 Native‑Plus full run과 다른 serving 반복이므로 직접 paired 비교가 아니라 위치 파악용이다.

| Protocol | BFCL strict | ACE strict | MCPMark Easy |
|---|---:|---:|---:|
| Native | **83.1%** | **81%** | **8/10** |
| Morph XML | **83.1%** | 75% | 0/10 |
| GLM Canonical text | 74.1% | 50% | 0/10 |
| YAML XML | 72.6% | 71% | 0/10 |
| Hermes | 70.8% | 54% | 0/10 |
| UI-TARS | 69.5% | 55% | 4/10 |
| Qwen3Coder | 68.2% | 55% | 0/10 |
| Sijawara Detailed | 28.9% | 14% | 0/10 |
| Sijawara Concise | 28.1% | 26% | 1/10 |

순수 text protocol 중 single-turn 성능은 Morph XML이 가장 강했지만 MCPMark에서는 0/10이었다. GLM Canonical의 주 병목은 parser syntax가 아니라 tool action을 시작하지 않는 behavior였다. 그 결과가 Native‑primary hybrid 설계의 근거가 됐다.

## Benchmark Coverage Audit

“가용 benchmark 총동원”은 별도 유료 judge/key/service 없이 현재 환경에서 재현 가능한 suite는 실행하고, 나머지는 실행한 것처럼 과장하지 않는 범위로 정의했다.

| Benchmark | 상태 | 범위/제외 사유 |
|---|---|---|
| BFCL | 완료 | 456-case paired full + 13-category live SSE |
| ACEBench | 완료 | Oracle-valid EN/ZH 100-case derived panel |
| MCPMark | 완료 | Filesystem Easy 10-task paired full + 3-task live SSE |
| τ³-bench | Feasibility only | user-simulator LLM, domain state, 별도 orchestration 필요 |
| ToolSandbox | Feasibility only | stateful environment, simulator, 일부 RapidAPI 의존 |
| ComplexFuncBench | Feasibility only | RapidAPI, embedding, comparator/judge 필요 |
| ToolBench / StableToolBench | Feasibility only | ToolEval/judge 및 API/mirror service 필요 |
| AppWorld | Feasibility only | protected bundle, 457-API stateful world, DB evaluation 필요 |
| VAKRA | Feasibility only | 약 35 GB data와 별도 local API/RAG stack 필요 |

## 비용과 지연

Endpoint `/models`의 `zai-org/glm-5.2` pricing 필드는 `null`이었다. 따라서 토큰을 임의 가격으로 환산하지 않았다. 보고된 비용 대용치는 input/output/total token이며, retry 중 실패한 request의 token은 provider usage가 없으면 포함되지 않아 실제 비용의 하한일 수 있다.

## Reproducibility 및 보안

- Model: `zai-org/glm-5.2`, temperature 0, auto tool choice.
- BFCL/ACE: 1,024 output tokens, provider retry 최대 2회, paired arm 선두 hash 교대.
- MCPMark: 최대 100 turns, turn당 4,096 output tokens, fresh hash-verified snapshot과 official verifier.
- Full BFCL 912, ACE 200, MCPMark 20 jobs에서 missing/duplicate/provider/scorer final error는 0.
- Full capture는 BFCL 912 JSON, ACE 200 JSON, MCPMark 110 JSON response이며 linkage와 credential scan을 통과했다.
- Live capture는 BFCL 26 SSE, MCPMark 41 SSE response이며 linkage와 credential scan을 통과했다.
- API secret의 source/result exact-match scan은 0이었다.
- `pnpm check`: benchmark TypeScript 포함 통과.
- `pnpm test`: 229 files, 2,637 tests 통과.
- `pnpm build`, `pnpm test:package-consumers`, `pnpm attw` ESM Node16/Bundler 통과.
- Python cross-report fixture tests 2/2 통과.

## 제한사항

- 한 endpoint, 한 model ID, 한 날짜의 serving snapshot이다. Backend revision, routing, quantization은 외부에서 확인할 수 없다.
- Temperature 0이어도 request-identical 반복 결과가 달랐다. 단일 paired trial은 이 변동을 완전히 평균내지 못한다.
- MCPMark는 Easy 10-task panel이며 전체 Verified 127-task를 대표하지 않는다.
- BFCL/ACE는 protocol comparison을 위한 adapted inference setting으로 공식 leaderboard 점수와 직접 비교할 수 없다.
- Full snapshot에는 repair/fallback target이 0건이어서 희소 오류의 실제 발생률과 online 기대 gain을 추정할 수 없다.
- Stream responsiveness의 TTFT/first-tool-call timestamp는 캡처하지 않았다. 여기서 검증한 것은 final semantic/lifecycle parity와 chunk invariance다.
- 가격 메타데이터가 없어 USD 비용을 보고하지 않았다.

## 운영 권고

1. **Native를 기본 경로로 유지한다.** 이번 full evidence에서 Native‑Plus의 일관된 성능 우월성은 없다.
2. **Native‑Plus는 repair-only safety net으로 opt-in한다.** 희소 malformed argument 또는 Native가 text에만 남긴 exact tool call을 복구해야 하는 endpoint에 적합하다.
3. **Steering prompt는 기본 비활성화한다.** dev panel에서 이득이 없고 ACE에서 1건 손실이 있었다.
4. **SSE replay를 회귀 gate로 유지한다.** raw byte와 internal delta 양쪽의 deterministic rechunk 검증을 CI에 포함한다.
5. **다음 성능 연구는 반복 trial과 오류 주입으로 분리한다.** 동일 request의 serving variance는 multi-trial로 추정하고, repair 정확도는 captured corruption corpus로 별도 측정한다.

## 주요 산출물

- Full BFCL: `results/2026-07-17-glm5-native-plus-bfcl-v4-456-generate-v1/`
- Full ACE: `results/2026-07-17-glm5-native-plus-ace-normal-100-generate-v1/`
- Full MCPMark: `results/2026-07-17-glm5-native-plus-mcpmark-filesystem-easy-10-generate-v1/`
- BFCL live SSE: `results/2026-07-17-glm5-native-plus-bfcl-v4-13-sse-v1/`
- MCPMark live SSE: `results/2026-07-17-glm5-native-plus-mcpmark-representative-3-sse-v1/`
- Cross-suite: `results/2026-07-17-glm5-native-plus-cross-generate-v1/`
- Request parity: `cross-generate-v1/request-parity.json`
- Intervention audit: `cross-generate-v1/intervention-audit.json`
- Stream replay validation: `cross-generate-v1/stream-replay-validation.json`

## Sources

- GLM‑5.2 official template revision `b4734de4facf877f85769a911abafc5283eab3d9`
- BFCL / Gorilla `6ea57973c7a6097fd7c5915698c54c17c5b1b6c8`
- ACEBench `56dd66cf6439b0d9655ee1b353e4cd745c6f664e`
- MCPMark `cd45b7f57923b9b3985467f5139927575f83141c`
