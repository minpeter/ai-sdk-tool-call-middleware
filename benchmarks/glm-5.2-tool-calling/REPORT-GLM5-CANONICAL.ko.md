# GLM 5.2 공식 Canonical 도구 호출 재검증 — Native 및 8개 Text Protocol 통합

작성일: 2026-07-17 (Asia/Seoul)

## Executive Summary

`zai-org/glm-5.2`를 `https://freerouter.minpeter.workers.dev/v1`에서 provider-native tool calling과 GLM-5.2 공식 chat template의 canonical text grammar로 동일 case에 짝지어 재검증했다. 이 결과는 앞서 완료한 Native + 7 middleware 연구에 여덟 번째 text protocol인 **GLM-5.2 Canonical**을 추가한다. 전체 연구 범위는 Native를 포함한 9개 protocol, 5,660개 primary job과 26개 실제 SSE 보조 job이다. credential 값은 source, metadata, capture, report에 저장하지 않았다.

결론은 명확하다.

1. **현재 endpoint의 production 기본값은 Native가 맞다.** Canonical arm은 BFCL 338/456(74.1%) 대 Native 380/456(83.3%), ACEBench-derived 50/100(50%) 대 81/100(81%), MCPMark Filesystem Easy 0/10 대 8/10이었다.
2. **차이는 우연한 paired fluctuation으로 보기 어렵다.** Native가 맞고 Canonical이 틀린 case와 반대 case는 BFCL 51 대 9(exact McNemar p=3.09×10⁻⁸), ACE 33 대 2(p=3.67×10⁻⁸), MCPMark 8 대 0(p=0.0078125)이었다.
3. **parser 무결성보다 모델의 text-only tool engagement가 병목이었다.** Availability는 두 정적 panel 모두 100%였고 ACE parser error·markup leak·boundary whitespace는 0이었다. BFCL parser error는 2/456이었지만 missing call이 Native 9건에서 Canonical 58건으로 증가했다. MCPMark에서는 10개 task 모두 1 turn, tool call 0개로 종료됐다.
4. **공식 grammar를 그대로 구현했다는 사실이 Native 동등성을 보장하지 않는다.** Canonical parser의 문법 정합성은 높았지만, provider-native interface와 system prompt로 serialized catalog를 전달하는 text path의 관측 행동은 달랐다.

> 의사결정: 이 endpoint에서는 Native를 기본 경로로 유지한다. Canonical text protocol은 Native가 불가능한 환경의 실험적 fallback으로만 두고, BFCL/ACE regression과 multi-turn execution gate를 통과하기 전 production agent 경로에 승격하지 않는다.

📊 시각 자료: 세 benchmark의 Native 대 Canonical 요약

## Context & Scope

이 연구는 모델 간 비교가 아니라 **같은 모델에서 tool protocol adapter가 성능을 얼마나 보존하는지**를 측정한다. 기존 all-protocol baseline은 다음 8개 arm을 포함했다.

| Arm | 경로 |
|---|---|
| Native | Provider-native tools |
| Hermes | Hermes text protocol middleware |
| Morph XML | Morph XML protocol middleware |
| YAML XML | YAML-in-XML protocol middleware |
| Qwen3Coder | Qwen-style text protocol middleware |
| Sijawara Detailed | Detailed XML community middleware |
| Sijawara Concise | Concise XML community middleware |
| UI-TARS | UI-TARS/Qwen 계열 community middleware |

이번 addendum은 여기에 다음 arm을 추가했다.

| Arm | 경로 | 출처 |
|---|---|---|
| GLM-5.2 Canonical | 공식 GLM-5.2 tool-call grammar를 사용하는 text middleware | Hugging Face `zai-org/GLM-5.2` chat template revision `b4734de4facf877f85769a911abafc5283eab3d9` |

기존 8-arm 연구는 4,528개 job, 이번 paired 재검증은 1,132개 primary job(BFCL 912, ACE 200, MCPMark 20)을 실행했다. 별도로 category당 1개씩 고른 BFCL 13-case를 Native/Canonical 양쪽에서 실제 SSE transport로 실행해 26개 response를 capture했다. 합계는 5,686개 model job이다.

기존 all-protocol 상세 리포트: [GLM 5.2 도구 호출 프로토콜 성능 리포트 — Native 및 7개 Middleware](https://app.notion.com/p/GLM-5-2-Native-7-Middleware-39f4b283be44815891e7d4d452fd7141)

📊 시각 자료: 기존 Native + 7 middleware 교차 benchmark 비교

## Canonical Grammar & Implementation

공식 template의 도구 호출 형식은 다음과 같다.

```text
<tool_call>function_name
<arg_key>key</arg_key>
<arg_value>value</arg_value>
</tool_call>
```

- Model source: `zai-org/GLM-5.2`
- Pinned revision: `b4734de4facf877f85769a911abafc5283eab3d9`
- Pinned chat template SHA-256: `172dc74a35e1752df75ecfb2b2cf9326d2852bb1379868ebeec9571654489679`
- History policy: provider-native assistant/tool history 보존
- Tool catalog policy: auto 선택에서는 official-style standalone tool catalog 주입
- Forced choice policy: `required` 또는 fixed-tool에서는 충돌하는 XML catalog를 억제하고 JSON Schema response format 사용
- Streaming policy: chunk-invariant incremental parser, 1 MiB hard cap, overflow 후 fail-closed, lifecycle balancing

Parser는 실측 점수를 본 뒤 조정하지 않았다. 구현과 regression test를 먼저 동결하고 같은 snapshot으로 모든 live measurement를 수행했다.

📊 시각 자료: Canonical parser 처리 파이프라인

## Methodology

### 공통 inference 조건

- Model: `zai-org/glm-5.2`
- Endpoint: `https://freerouter.minpeter.workers.dev/v1`
- Temperature: 0
- Tool choice: automatic
- BFCL/ACE output limit: 1,024 tokens
- BFCL/ACE request timeout: 120 seconds
- Provider retry: 최대 2회
- BFCL/ACE concurrency: 16
- MCPMark concurrency: 4, 최대 100 turns, turn당 최대 4,096 output tokens
- 비교 통제: 동일 case/task, user request, tool schema, common instruction, model, endpoint

### Paired scheduling과 primary score

Native와 Canonical은 같은 worker batch 안에서 순차 실행했다. 어느 arm이 먼저 실행되는지는 seed hash로 교대해 지속적인 backend drift가 한쪽에만 쏠리지 않도록 했다. 한 arm만 완료된 asymmetric resume은 거부했다.

Primary score는 provider/parser 실패까지 incorrect로 포함하는 **end-to-end strict outcome**이다. 같은 case의 두 arm을 짝지어 exact two-sided McNemar test를 계산했다. Provider-successful row만 보는 conditional semantic/strict score는 진단용 secondary metric으로 따로 보존했다.

📊 시각 자료: paired 실행·검증 설계

### Benchmark 구성

| Suite | 범위 | Cases/tasks | Primary evaluator |
|---|---|---:|---|
| BFCL V4 derived | 13 single-turn/static/live category, SHA-256 stratified | 456/arm | Pinned BFCL AST checker + protocol-strict overlay |
| ACEBench-derived Normal | EN/ZH × 10 category × 5 cases | 100/arm | Pinned ACE `normal_checker` + strict overlay |
| MCPMark Filesystem Easy | 공식 Easy task, fresh filesystem snapshot | 10/arm | Pinned official `verify.py` |
| BFCL real SSE | 13 category × 1 case | 13/arm | Live score + capture offline replay |

BFCL source는 `6ea57973c7a6097fd7c5915698c54c17c5b1b6c8`, ACEBench는 `56dd66cf6439b0d9655ee1b353e4cd745c6f664e`, MCPMark는 `cd45b7f57923b9b3985467f5139927575f83141c`에 고정했다. 이들은 custom/adapted protocol panel이며 공식 leaderboard submission이 아니다.

## Findings

### 1. Cross-suite 결과

| Benchmark | Native | GLM Canonical | 절대 차이 | Paired loss / recovery | Exact McNemar p |
|---|---:|---:|---:|---:|---:|
| BFCL V4 derived | **83.3% (380/456)** | 74.1% (338/456) | -9.2%p | 51 / 9 | 3.085×10⁻⁸ |
| ACEBench-derived | **81% (81/100)** | 50% (50/100) | -31%p | 33 / 2 | 3.673×10⁻⁸ |
| MCPMark FS Easy | **80% (8/10)** | 0% (0/10) | -80%p | 8 / 0 | 0.0078125 |

두 정적 panel에서 provider availability는 양쪽 모두 100%였다. 따라서 결과 차이는 transport outage로 설명되지 않는다. MCPMark도 setup/provider final failure 없이 20개 job이 모두 완료됐다.

### 2. BFCL: 호출 누락이 순손실을 주도

| Arm | E2E strict | Category macro | 95% Wilson CI | p50 / p95 | Parser errors | Missing calls |
|---|---:|---:|---:|---:|---:|---:|
| Native | **83.3%** | **82.3%** | 79.6–86.5% | **2.68s / 5.71s** | 0 | 9 |
| GLM Canonical | 74.1% | 71.9% | 69.9–77.9% | 2.91s / 13.18s | 2 | 58 |

가장 큰 category 순손실은 `live_multiple` -14건, `multiple` -7건, `live_parallel_multiple` -7건, `live_simple` -6건이었다. Canonical이 Native 실패를 복구한 category도 있었지만 `live_irrelevance` +3건, `irrelevance` +2건에 그쳤다. Native→Canonical conversion loss 51건 중 **42건이 missing call**이었다.

두 parser-error row는 `simple_java_45`, `simple_javascript_9`였다. 둘 다 `<tool_call>` markup 자체는 생성했지만 required object/callback argument 대신 `envVariables`, `responseData`, `processKeyFunction` 같은 identifier text를 값으로 내어 schema-compatible call로 복원되지 않았다. Native도 동일 두 case에서 malformed였으므로 이 둘은 paired gap을 만들지 않았다. 전체 순손실 42건을 parser error 2건으로 설명할 수 없다.

📊 시각 자료: BFCL 전체 정확도와 95% Wilson CI

📊 시각 자료: BFCL paired loss와 recovery

📊 시각 자료: BFCL category heatmap

### 3. ACE: 영어 panel에서 특히 큰 하락

| Arm | E2E strict | EN | ZH | p50 / p95 | Parser/leak/whitespace |
|---|---:|---:|---:|---:|---:|
| Native | **81%** | **82%** | **80%** | **3.26s / 40.78s** | 0 / 0 / 0 |
| GLM Canonical | 50% | 36% | 64% | 4.83s / 21.83s | 0 / 0 / 0 |

Canonical의 paired 순손실은 영어 -22건(loss 23, recovery 1), 중국어 -8건(loss 9, recovery 1)이었다. Category별로는 `normal_atom_enum` -6, `normal_atom_number` -5, `normal_atom_object_short` -4, `normal_single_turn_single_function` -3이 컸다. Conversion loss 33건 중 **30건이 missing call**이었다. Canonical failure 50건 전체로 보면 missing call 40건, wrong value 8건, extra argument 2건이었다.

Canonical의 ACE parser error, markup leak, argument-boundary whitespace는 모두 0이었다. 이 결과 역시 문법 decode 실패보다 모델이 영어 prompt의 tool call을 선택하지 않는 문제가 중심임을 지지한다. 언어별 n=50이므로 28%p 언어 격차를 모델 전체 특성으로 일반화하지는 않는다.

📊 시각 자료: ACE 전체 정확도

📊 시각 자료: ACE 영어·중국어 split

📊 시각 자료: ACE category heatmap

📊 시각 자료: ACE paired loss와 recovery

### 4. MCPMark: Canonical이 multi-turn loop에 진입하지 못함

| Arm | Verifier pass | Turns | Tool calls | Calls/job | Tokens/job |
|---|---:|---:|---:|---:|---:|
| Native | **8/10** | 63 | 64 | 6.4 | 45,296 |
| GLM Canonical | 0/10 | 10 | 0 | 0.0 | 1,968 |

Native는 `file_splitting`, `uppercase`, `largest_rename`, `txt_merging`, `structure_analysis`, `file_reorganize`, `duplicate_name`, `recommender_name`을 통과해 총 8/10이었다. 실패한 `pattern_matching`은 길이 제한에 걸린 뒤 `answer.txt`를 쓰지 못했고, `papers_counting`은 기대값 83 대신 85를 기록했다. Canonical은 10개 task 모두 첫 model turn에서 종료해 MCP server call이 0개였다. 8건은 reasoning-only, 2건은 reasoning+text였으며 parser error, MCP execution error, attempt timeout이 아니라 **tool non-engagement**로 official verifier가 모두 실패했다.

Canonical의 낮은 latency와 token 수는 효율 우위가 아니다. 작업을 수행하지 않고 조기 종료한 결과다. MCPMark n=10의 Wilson interval은 넓지만, 10/10 task에서 call 0이라는 행동 패턴은 운영상 중요한 실패 신호다.

📊 시각 자료: MCPMark official verifier 성공률

📊 시각 자료: MCPMark task heatmap

📊 시각 자료: MCPMark paired loss와 recovery

📊 시각 자료: MCPMark turns·calls·token footprint

### 5. 실제 SSE transport와 offline replay

13개 BFCL category에서 한 case씩 골라 Native와 Canonical을 실제 SSE로 실행했다. Native는 11/13(84.6%), Canonical은 7/13(53.8%)이었고 paired loss/recovery는 4/0이었다. 표본이 작아 exact McNemar p=0.125였으며, 이 보조 run은 성능 추정보다 streaming parser 검증이 주목적이다. 26/26 response가 transport-success였고 capture media type은 모두 SSE였다. Missing/duplicate/provider/scorer final error는 0이었으며 capture-result linkage와 credential scan을 통과했다.

`provider-raw.jsonl`의 SSE body를 production parser에 offline replay한 결과는 `replayed.jsonl`에 26개 row로 보존했다. Live/capture/replay는 13 Native + 13 Canonical로 정확히 일치했고 parser error는 0이었다. Normalized calls와 parsed text는 26/26 row에서 live 결과와 exact match였으며 raw body/text SHA-256도 26/26 검증됐다. 독립 재실행한 offline replay는 byte-identical했고 `replayed.jsonl` SHA-256은 `f00f8cab1f203c90097e8eb44abfbeecf0cc1f0f8b4c1e194c210865163809b3`였다.

📊 시각 자료: 실제 SSE 13-category 결과

## All-protocol Context

Canonical의 위치를 해석하기 위해 기존 8-arm baseline을 함께 본다. 아래 수치는 동일한 dataset panel의 기존 run이며, paired canonical run의 Native는 backend snapshot을 통제하기 위해 별도로 재실행했다.

| Protocol | BFCL strict | ACE strict | MCPMark Easy |
|---|---:|---:|---:|
| Native | **83.1%** | **81%** | **8/10** |
| Morph XML | **83.1%** | 75% | 0/10 |
| GLM Canonical (이번 paired run) | 74.1% | 50% | 0/10 |
| YAML XML | 72.6% | 71% | 0/10 |
| Hermes | 70.8% | 54% | 0/10 |
| UI-TARS | 69.5% | 55% | 4/10 |
| Qwen3Coder | 68.2% | 55% | 0/10 |
| Sijawara Detailed | 28.9% | 14% | 0/10 |
| Sijawara Concise | 28.1% | 26% | 1/10 |

Canonical은 BFCL에서 Morph XML보다 낮고 YAML XML보다 높았지만, ACE에서는 Hermes/Qwen3Coder/UI-TARS보다도 낮았다. MCPMark는 Morph·YAML·Hermes·Qwen3Coder·Sijawara Detailed와 같은 0/10이지만, 이들 중 일부는 실제 call을 만든 반면 Canonical은 call 0이라는 더 근본적인 non-engagement를 보였다.

기존 연구의 production 판단도 유지된다. Native가 가능하면 Native를 사용하고, single-turn text-only fallback 후보는 현재까지 Morph XML이 가장 강하다. 다만 Morph도 MCPMark 0/10이므로 stateful agent fallback으로 자동 승격할 근거는 없다.

## Benchmark Coverage Audit

“가용 benchmark 총동원”은 credential·judge·대규모 별도 service 없이 현재 환경에서 신뢰성 있게 재현 가능한 suite를 실제 실행하고, 나머지는 실행한 것처럼 과장하지 않고 feasibility audit로 남기는 방식으로 해석했다.

| Benchmark | 상태 | 경계/제외 사유 |
|---|---|---|
| BFCL | 실행 완료 | Custom SHA-stratified 456-case protocol panel |
| ACEBench | 실행 완료 | Oracle-valid EN/ZH 100-case derived panel |
| MCPMark | 실행 완료 | Official Filesystem Easy 10-task adapted loop |
| τ³-bench | Feasibility audit | 별도 user-simulator LLM, domain state, orchestration 필요 |
| ToolSandbox | Feasibility audit | Stateful environment, user simulator, 일부 RapidAPI 의존성 |
| ComplexFuncBench | Feasibility audit | Booking RapidAPI, embedding, external comparator/judge 필요 |
| ToolBench | Feasibility audit | ToolBench/RapidAPI server 또는 key와 ToolEval judge 필요 |
| StableToolBench | Feasibility audit | MirrorAPI/cache simulator, judge model, 별도 service 필요 |
| AppWorld | Feasibility audit | Protected bundle, 457-API stateful world, DB evaluation 필요 |
| VAKRA | Feasibility audit | 약 35 GB data, 8 GB+ container memory, local API/RAG stack 필요 |

## Limitations

- 한 endpoint, 한 model ID, 한 날짜의 serving snapshot이다. Backend routing, quantization, cache, serving revision은 외부에서 확인할 수 없다.
- Temperature 0의 단일 trial이다. GLM-5.2 serving이 완전 결정적이라는 보장은 없으며 반복 trial 분산은 추정하지 않았다.
- BFCL·ACE는 protocol 비교를 위한 custom inference setting이고 MCPMark도 adapted Easy loop이다. 공식 leaderboard 점수와 직접 비교할 수 없다.
- MCPMark는 arm당 10개뿐이며 127-task Verified standard suite를 대표하지 않는다.
- ACE EN/ZH split은 언어당 50개여서 언어 격차를 일반화하기에는 작다.
- Latency는 공유 backend와 concurrency의 영향을 받는다. Suite 간 절대 latency를 직접 비교하지 않았다.
- Endpoint 가격 정보가 없어 monetary cost는 계산하지 않았다.
- Forced tool choice는 endpoint의 `response_format.json_schema` 지원을 전제로 하며 이번 auto-choice benchmark와 별도 경로다.

## Actions

1. **Native를 production default로 유지한다.** Availability, malformed native arguments, schema drift를 별도 SLO로 모니터링한다.
2. **Canonical은 experimental flag 뒤에 둔다.** BFCL ≥ Native-3%p, ACE ≥ Native-5%p, MCPMark Easy에서 tool call engagement 10/10 및 verifier pass 기준을 통과하기 전 자동 fallback으로 사용하지 않는다.
3. **Prompt·serving 원인을 parser와 분리해 진단한다.** Parser tuning 없이 catalog placement, tool-choice steering, assistant history serialization을 사전등록한 ablation으로 측정한다.
4. **SSE replay를 regression gate로 유지한다.** Chunk boundary, call ID, start/delta/end lifecycle, 1 MiB overflow fail-closed를 package tests와 live capture replay 양쪽에서 검증한다.
5. **다음 확장 우선순위는 MCPMark Verified 127-task와 반복 trial이다.** Static score 개선만으로 multi-turn production readiness를 판단하지 않는다.

## Reproducibility & Validation

### Result directories

- BFCL paired: `results/2026-07-17-glm5-native-bfcl-v4-456-generate/`
- ACE paired: `results/2026-07-17-glm5-native-ace-normal-100-generate/`
- MCPMark paired: `results/2026-07-17-glm5-native-mcpmark-filesystem-easy-10-generate/`
- Real SSE: `results/2026-07-17-glm5-native-bfcl-v4-13-sse/`
- Cross-suite: `results/2026-07-17-glm5-native-cross-generate/`
- Failure taxonomy: `results/2026-07-17-glm5-native-cross-generate/failure-taxonomy.md`
- SSE replay validation: `results/2026-07-17-glm5-native-bfcl-v4-13-sse/replay-validation.json`

### Completeness and security

- BFCL: 456 cases / 912 final jobs, missing 0, duplicate final job 0, provider/scorer final error 0. Capture는 transient Native transport retry 1건을 포함해 913 rows이며 final 912 jobs는 모두 성공했다.
- ACE: 100 cases / 200 jobs, missing 0, duplicate 0, provider/scorer error 0, parser/leak/boundary-whitespace 0.
- MCPMark: 10 tasks / 20 jobs, missing 0, duplicate 0, setup/provider failure 0, official verifier/output SHA valid.
- SSE: 13 cases / 26 jobs, real SSE media 26, missing/duplicate/provider/scorer error 0, live↔offline normalized call/text exact 26/26, replay parser error 0.
- 모든 capture/result linkage validator와 credential redaction scan을 통과했다.
- Resume configuration에는 runner, parser, scorer, analyzer, validator, lockfile 및 source-content fingerprint가 포함된다.

### Repository regression

- `pnpm test`: 223 files, 2,536 tests passed
- `pnpm check`: passed
- `pnpm build`: passed
- `pnpm test:package-consumers`: passed
- `pnpm attw`: ESM Node16/Bundler passed

## Sources

- [GLM-5.2 official chat template @ b4734de4](https://huggingface.co/zai-org/GLM-5.2/blob/b4734de4facf877f85769a911abafc5283eab3d9/chat_template.jinja)
- [BFCL / Gorilla @ 6ea57973](https://github.com/ShishirPatil/gorilla/tree/6ea57973c7a6097fd7c5915698c54c17c5b1b6c8)
- [ACEBench @ 56dd66cf](https://github.com/chenchen0103/ACEBench/tree/56dd66cf6439b0d9655ee1b353e4cd745c6f664e)
- [MCPMark @ cd45b7f5](https://github.com/eval-sys/mcpmark/tree/cd45b7f57923b9b3985467f5139927575f83141c)
- [기존 Native + 7 middleware 상세 연구](https://app.notion.com/p/GLM-5-2-Native-7-Middleware-39f4b283be44815891e7d4d452fd7141)
