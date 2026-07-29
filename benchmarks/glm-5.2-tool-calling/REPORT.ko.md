# GLM 5.2 도구 호출 프로토콜 성능 리포트 — Native 및 7개 Middleware

작성일: 2026-07-17 (Asia/Seoul)

## Executive Summary

`zai-org/glm-5.2`를 동일한 OpenAI-compatible endpoint에서 Native tool calling과 이 저장소의 7개 text protocol middleware로 비교했다. 최종 측정에는 456-case BFCL V4 파생 패널 3,648개, 영어·중국어 100-case ACEBench 파생 패널 800개, 실제 파일을 조작하는 MCPMark Filesystem Easy 80개 등 **총 4,528개 고유 job**을 사용했다. 두 정적 패널은 provider availability 100%였고, MCPMark에서는 이전 attempt의 transient provider timeout 3건이 모두 새 snapshot 재시도로 회복됐다. 세 패널 모두 누락 job과 미회복 infrastructure failure가 0임을 validator로 확인했다.

결론은 세 가지다.

1. **현재 production 기본값은 Native가 가장 안전하다.** BFCL strict micro accuracy는 Native와 Morph XML이 모두 83.1%였지만, category-macro에서는 Native가 82.8%로 Morph XML의 82.1%보다 조금 높았다. ACE protocol-strict에서도 Native 81%, Morph XML 75%였다. 실제 multi-turn MCPMark Easy에서는 Native 8/10, 차점인 UI-TARS 4/10이었다. Native는 BFCL에서 가장 적은 평균 token을 사용했고 ACE에서는 가장 짧은 p50 latency를 보였다.
2. **정적·단일턴 text protocol이 필요한 경우 Morph XML이 가장 강한 후보지만, multi-turn fallback으로 바로 승격할 근거는 없다.** BFCL paired comparison에서 Native가 맞고 Morph가 틀린 14건과 그 반대 14건이 정확히 상쇄됐고 exact McNemar p=1.0이었다. ACE에서도 Native 대비 순손실은 6건, paired p=0.146이었다. 반면 MCPMark Easy에서는 10개 중 2개 task에서만 실제 MCP call을 만들었고 최종 verifier 통과는 0건이었다. 정적 정확도와 end-to-end agent 성공률을 별도 gate로 운영해야 한다.
3. **Sijawara의 낮은 strict 점수는 모델 능력보다 parser whitespace corruption의 영향이 매우 크다.** 문자열 값에 XML indentation과 newline이 들어가 `"Amazon"`이 `"\n    Amazon\n  "`처럼 변했다. BFCL 관측 점수는 Detailed 28.9%, Concise 28.1%였지만, decoded string을 재귀적으로 trim한 진단용 사후 분석에서는 각각 80.7%, 79.6%까지 회복됐다. 이 counterfactual은 실제 benchmark 점수가 아니지만 parser 수정 우선순위를 분명히 보여준다.

## Background & Context

이 연구의 목적은 모델 자체를 다른 모델과 비교하는 것이 아니라, **같은 모델·같은 요청·같은 tool schema에서 protocol adapter가 결과를 얼마나 보존하거나 훼손하는지** 측정하는 것이다. 비교 arm은 다음과 같다.

| Arm | 경로 | 비고 |
|---|---|---|
| Native | Provider-native tools | 기준선 |
| Hermes | Hermes text protocol | Middleware |
| Morph XML | Morph XML protocol | Middleware |
| YAML XML | YAML-in-XML protocol | Middleware |
| Qwen3Coder | Qwen-style text protocol | Middleware |
| Sijawara Detailed | Detailed XML protocol | Community middleware |
| Sijawara Concise | Concise XML protocol | Community middleware |
| UI-TARS | UI-TARS/Qwen 계열 protocol | Community middleware |

Middleware source는 저장소 commit `d2e56ceb6302fe8028ea87ce7c945b92184779cd` 기준이다. API credential은 source, raw result, metadata 및 이 리포트에 기록하지 않았다.

## Methodology

### BFCL·ACE 공통 inference 조건

- Model: `zai-org/glm-5.2`
- Endpoint: `https://freerouter.minpeter.workers.dev/v1`
- Temperature: 0
- Tool choice: automatic
- Output limit: 1,024 tokens
- Request timeout: 120 seconds
- Provider retry: 최대 2회
- Concurrency: 16
- 비교 통제: case, user request, tool schema, common instruction, model 및 endpoint 동일
- Provider failure: conditional accuracy의 분모와 분리하고 availability로 별도 보고
- Latency: concurrency 16의 공유 부하에서 측정한 end-to-end 값. 단일 사용자 latency로 해석하지 않음

### BFCL V4 파생 protocol panel

BFCL source는 commit `6ea57973c7a6097fd7c5915698c54c17c5b1b6c8`에 고정했다. 13개 single-turn/static/live category에서 seed 52와 `SHA-256(seed + NUL + category + NUL + case ID)` 순위를 사용해 category당 최대 40개를 선택했다. 원본 category 크기가 더 작은 `live_parallel`, `live_parallel_multiple`, `live_relevance`를 포함해 총 456 cases가 됐다.

- Semantic score: pinned BFCL official AST checker
- Protocol-strict score: semantic correctness + decoded argument object shape + parser error 없음 + protocol markup leak 없음
- Primary aggregation: 456 cases에 대한 micro accuracy
- Secondary aggregation: 13 category accuracy의 단순 평균인 category-macro
- Confidence interval: 현재 custom panel의 binomial proportion에 대한 95% Wilson interval
- Paired test: 같은 case의 Native와 middleware 결과에 대한 exact two-sided McNemar test, 다중비교 보정 전 값

이 결과는 **custom SHA-stratified single-turn panel**이며 공식 BFCL leaderboard submission 또는 공식 leaderboard score가 아니다. Java/JavaScript schema는 AI SDK가 처리할 수 있는 JSON Schema 등가형으로 변환했고, checker 입력도 decoded JSON value에 맞춰 context-aware type normalization을 적용했다.

### ACEBench-derived bilingual panel

ACEBench source는 commit `56dd66cf6439b0d9655ee1b353e4cd745c6f664e`에 고정했다. Normal static 10개 category에서 영어·중국어 각각 5개씩, 총 100 cases를 SHA-256으로 선택해 800 jobs를 실행했다.

공식 `normal_checker`에 ground truth 자체를 입력하는 oracle self-test에서 1,200개 Normal static row 중 8개가 upstream checker/data 불일치로 실패했다. 이 8개는 sampling 전에 제외했고, 최종 100개는 모두 oracle-valid임을 다시 확인했다.

ACE 공식 inference는 AST 형식의 text output을 요구하지만 이번 연구는 모든 arm에 동일한 AI SDK tool interface를 제공했다. 따라서 결과명은 **ACEBench-derived protocol comparison**이며 공식 ACE leaderboard 설정과 동일하지 않다.

ACE checker는 일반적인 `trim`을 수행하지 않는다. 대신 ASCII space와 일부 문장부호를 제거하는 표준화와 normal string의 substring matching이 결합돼, XML indentation에서 유입된 boundary newline이 있어도 semantic correct로 인정될 수 있었다. 이를 숨기지 않기 위해 두 점수를 보존했다. 최종 oracle 102개 후보의 435개 string leaf에는 boundary whitespace가 없었고 oracle 재채점도 100/100이었으므로, 아래 strict overlay는 선택 패널의 정답 데이터를 부당하게 거부하지 않았다.

- ACE-checker semantic accuracy: pinned ACE `normal_checker` 결과
- Protocol-strict accuracy: semantic correctness + object shape + parser/markup integrity + oracle에는 없는 decoded argument 경계 whitespace 없음

### MCPMark Filesystem Easy multi-turn panel

MCPMark source는 commit `cd45b7f57923b9b3985467f5139927575f83141c`에 고정했다. 공식 Filesystem Easy 10개 task를 8개 arm에서 1회씩 실행해 80 jobs를 만들었다. Easy는 MCPMark가 smoke/CI slice로 제공하는 작은 subset이며 127-task Verified standard suite가 아니다.

- Dataset: 공식 6개 ZIP의 SHA-256을 고정·검증하고 task/arm/trial/retry마다 fresh copy-on-write snapshot 생성
- MCP server: `@modelcontextprotocol/server-filesystem@2025.12.18`, 매 job tool schema 재조회 및 preflight fingerprint 일치 확인
- Prompt: pinned upstream `BaseTaskManager`가 추가하는 suffix까지 포함하고 effective instruction SHA-256 기록
- Agent loop: 동일 AI SDK tool schema로 수동 multi-turn 실행, tool result를 다음 모델 turn에 전달, valid call은 MCP에서 순차 실행
- Primary success: 최종 fresh snapshot에서 pinned official `verify.py`가 exit 0
- 조건: temperature 0, turn당 최대 4,096 output tokens, model turn 120초, 최대 100 turns, attempt 전체 600초, concurrency 8
- Retry: provider/infrastructure failure만 최대 2회 재시도; parser·MCP·verifier failure는 같은 job 안에서 숨겨 재실행하지 않음
- 보안·무결성: API credential을 MCP server·verifier·기타 child process 환경에서 제거하고, clean upstream checkout·dataset hash·schema hash·run configuration fingerprint를 강제

이 결과는 공식 task·dataset·verifier를 사용하지만 model adapter, inference loop, system prompt와 protocol middleware가 이번 연구에 맞게 구성된 **adapted MCPMark Easy protocol panel**이다. 공식 MCPMark leaderboard 점수로 해석하지 않는다.

## Detailed Findings

### BFCL: 전체 accuracy, latency 및 efficiency

| Arm | Strict micro | Category macro | 95% Wilson CI | p50 / p95 | Mean tokens | Protocol integrity |
|---|---:|---:|---:|---:|---:|---:|
| Native | **83.1%** | **82.8%** | 79.4–86.3% | 3.26s / 12.23s | **627** | 99.6% |
| Morph XML | **83.1%** | 82.1% | 79.4–86.3% | **3.09s** / 16.52s | 871 | 97.8% |
| YAML XML | 72.6% | 72.4% | 68.3–76.5% | 3.22s / **11.83s** | 727 | 89.3% |
| Hermes | 70.8% | 67.4% | 66.5–74.8% | 3.76s / 19.29s | 893 | 95.8% |
| UI-TARS | 69.5% | 68.7% | 65.1–73.6% | 3.59s / 18.31s | 1,037 | 99.8% |
| Qwen3Coder | 68.2% | 66.5% | 63.8–72.3% | 3.79s / 16.81s | 880 | **100.0%** |
| Sijawara Detailed | 28.9% | 28.1% | 25.0–33.3% | 3.64s / 15.50s | 800 | 96.9% |
| Sijawara Concise | 28.1% | 27.3% | 24.1–32.4% | 3.33s / 15.94s | 677 | 97.4% |

Native와 Morph XML은 micro correct count가 379/456으로 같았다. 그러나 같은 case를 짝지어 보면 결과가 완전히 동일한 것은 아니다. Morph XML은 Native가 맞힌 14개를 잃는 대신 Native가 틀린 14개를 복구했다. 나머지 middleware는 Native 대비 순손실이 Hermes -56, YAML XML -48, Qwen3Coder -68, UI-TARS -62, Sijawara Detailed -247, Sijawara Concise -251이었다. Morph를 제외한 차이는 이 패널에서 exact McNemar p<2.4×10⁻⁹였다.

Category별로는 Morph XML이 `live_parallel` 93.8%, `parallel` 95.0%, `parallel_multiple` 90.0%로 강했다. Native는 `live_multiple` 80.0%, `live_parallel_multiple` 87.5%, `live_relevance` 75.0%에서 Morph보다 높았다. 두 arm의 총점 동률은 서로 다른 강점이 상쇄된 결과다. Hermes는 `simple_python`에서 95.0%였지만 live parallel 계열에서 약해 category-macro가 micro보다 낮았다.

### ACE: bilingual static validation

| Arm | Protocol-strict | ACE-checker semantic | 95% Wilson CI (strict) | EN / ZH strict | p50 / p95 | Mean tokens |
|---|---:|---:|---:|---:|---:|---:|
| Native | **81%** | **81%** | 72.2–87.5% | 82% / 80% | **5.11s** / **20.25s** | 1,230 |
| Morph XML | 75% | 76% | 65.7–82.5% | 78% / 72% | 8.90s / 48.75s | 1,389 |
| YAML XML | 71% | 71% | 61.5–79.0% | 72% / 70% | 8.47s / 47.58s | 1,237 |
| Qwen3Coder | 55% | 55% | 45.2–64.4% | 66% / 44% | 8.89s / 48.07s | 1,461 |
| UI-TARS | 55% | 55% | 45.2–64.4% | 64% / 46% | 10.27s / 48.84s | 1,547 |
| Hermes | 54% | 54% | 44.3–63.4% | 60% / 48% | 8.92s / 47.18s | 1,472 |
| Sijawara Concise | 26% | 72% | 18.4–35.4% | 22% / 30% | 6.00s / 47.85s | 1,164 |
| Sijawara Detailed | 14% | 63% | 8.5–22.1% | 14% / 14% | 9.12s / 50.48s | 1,328 |

ACE paired comparison에서 Morph XML은 Native가 맞힌 9건을 잃고 3건을 복구해 net -6이었으며 exact McNemar p=0.146이었다. 즉 이 작은 패널만으로 Native와 Morph의 strict accuracy 차이를 확정하기 어렵다. YAML XML은 net -10, unadjusted p=0.021이었다. Hermes, Qwen3Coder, UI-TARS와 두 Sijawara arm은 Native보다 명확히 낮았다.

영어와 중국어 사이의 가장 큰 하락은 Qwen3Coder 66%→44%, UI-TARS 64%→46%, Hermes 60%→48%에서 나타났다. Native는 82%→80%, Morph XML은 78%→72%, YAML XML은 72%→70%로 상대적으로 안정적이었다. 각 언어의 arm당 n=50이므로 작은 차이는 과해석하지 않아야 한다.

BFCL과 ACE의 latency 절대값은 실행 시점과 backend 공유 부하가 다르므로 서로 직접 비교하지 않았다. 같은 ACE run 내부에서는 Native가 p50·p95 모두 가장 빨랐다.

### Failure taxonomy와 parser integrity

BFCL에서 주요 실패 패턴은 다음과 같다.

- **Sijawara Detailed/Concise:** wrong value 177/181건. decoded string 경계 whitespace가 있는 row는 284/290건이었고, 그중 strict correct는 각 8건뿐이었다.
- **Qwen3Coder:** missing call 80건. protocol integrity는 100%였으므로 형식 파손보다 모델이 해당 text protocol에서 tool call을 선택하지 않은 문제가 중심이다.
- **Hermes:** missing call 71건, parser error 11건, text leak 18건.
- **UI-TARS:** missing call 70건. 형식 무결성은 99.8%지만 호출 누락이 accuracy를 제한했다.
- **YAML XML:** text leak 49건으로 가장 많았고 protocol integrity가 89.3%로 하락했다.
- **Morph XML:** text leak 10건이 있었지만 그 행들은 이미 semantic failure여서 BFCL semantic과 strict 총점은 같았다. ACE에서는 semantic 76% 중 1건이 protocol-strict에서 탈락했다.

Sijawara whitespace counterfactual은 원본 raw response의 문자열 값을 바꾸지 않고 별도 사본에서 decoded string만 trim한 후 BFCL official checker를 다시 실행했다. Detailed는 132/456에서 368/456으로, Concise는 128/456에서 363/456으로 회복됐다. 이것은 실제 score를 대체하지 않으며, “parser가 whitespace를 보존했더라면”이라는 제한된 민감도 분석이다. 의도적인 leading/trailing whitespace가 필요한 실제 API도 있으므로 production fix는 무조건적인 global trim이 아니라 XML text node의 formatting indentation을 값과 분리하는 방식이어야 한다.

### MCPMark: end-to-end filesystem execution

| Arm | Verifier pass | 95% Wilson CI | p50 job latency | Turns / calls per job | Tokens per job |
|---|---:|---:|---:|---:|---:|
| Native | **80% (8/10)** | 49.0–94.3% | 103.44s | 6.1 / 6.1 | 45,807 |
| UI-TARS | 40% (4/10) | 16.8–68.7% | 106.51s | 3.6 / 2.9 | 72,608 |
| Sijawara Concise | 10% (1/10) | 1.8–40.4% | 307.53s | 8.8 / 8.0 | 34,187 |
| Hermes | 0% (0/10) | 0–27.8% | 70.77s | 1.0 / 0.0 | 2,716 |
| Morph XML | 0% (0/10) | 0–27.8% | 50.24s | 1.9 / 0.9 | 5,969 |
| YAML XML | 0% (0/10) | 0–27.8% | 17.79s | 3.4 / 3.8 | 10,094 |
| Qwen3Coder | 0% (0/10) | 0–27.8% | 49.17s | 1.2 / 0.2 | 3,175 |
| Sijawara Detailed | 0% (0/10) | 0–27.8% | 98.69s | 4.6 / 4.0 | 18,097 |

Native는 `pattern_matching`, `uppercase`, `largest_rename`, `txt_merging`, `structure_analysis`, `file_reorganize`, `duplicate_name`, `recommender_name`을 통과했고 `file_splitting`과 `papers_counting`을 실패했다. UI-TARS가 통과한 4개와 Sijawara Concise가 통과한 1개는 모두 Native도 통과한 task였다. 이 slice에서는 middleware가 Native의 실패를 복구한 case가 없었다.

Paired comparison에서 UI-TARS는 Native 대비 conversion loss 4, recovery 0으로 net -4였고 exact McNemar p=0.125였다. Sijawara Concise는 loss 7, recovery 0, p=0.0156이었다. 0/10인 다섯 arm은 loss 8, recovery 0, p=0.0078이었다. 표본이 arm당 10개뿐이고 7개 비교에 대한 보정 전 값이므로, 특히 UI-TARS 차이를 확정적 순위로 과해석하지 않는다.

실패 양상은 정적 패널보다 훨씬 선명했다.

- **Hermes:** 10 jobs 모두 1 turn에서 끝났고 실제 MCP call은 0개였다. 최종 primary attribution은 parser 6, verifier failure 4였다.
- **Morph XML:** 총 19 turns·9 calls를 만들었지만 10 jobs 모두 verifier failure였다. 호출은 `file_splitting`과 `structure_analysis` 두 task에 집중됐다.
- **Qwen3Coder:** 10 jobs 중 9개가 parser primary failure였고 전체 call은 2개뿐이었다.
- **YAML XML:** primary outcome은 verifier 7, MCP execution 2, 600초 attempt timeout 1이었다.
- **Sijawara Detailed/Concise:** 각각 2개 timeout이 있었다. Concise는 총 88 turns·80 calls를 수행했고 `recommender_name`에서 중간 MCP 오류를 복구해 유일한 1승을 만들었다.
- **UI-TARS:** 29 calls로 4개 task를 완료했다. 72,608 tokens/job은 큰 tool result와 누적 multi-turn context의 영향으로 이 패널에서 가장 높았다.

전체 80 jobs는 83 attempts, 306 turns, 259 MCP calls, 1,926,519 tokens를 사용했다. 이전 attempt에서 provider timeout이 3건 있었지만 모두 fresh snapshot 재시도로 회복됐고, 최종 미회복 provider/setup failure는 0이었다. 총 13/80 jobs가 verifier를 통과했다. Latency와 resource 수치는 retry attempt를 포함하며 concurrency 8의 공유 부하에서 측정했다.

## Benchmark Coverage Audit

요청한 “가용 benchmark 총동원”을 위해 주요 tool-calling benchmark의 현 실행 가능성을 조사했다. 정적 protocol 정확도는 BFCL·ACEBench로, 실제 multi-turn state mutation은 MCPMark Easy로 실행했다. 다음 suite는 결과를 측정한 것처럼 표기하지 않고, 제외 사유를 명시한다.

| Benchmark | 이번 상태 | 실행하지 않은 이유 |
|---|---|---|
| τ³-bench | Feasibility audit | 별도 user-simulator LLM, domain state 및 multi-turn orchestration 필요 |
| ToolSandbox | Feasibility audit | stateful interactive environment, user simulator와 일부 RapidAPI 의존성, custom endpoint adapter 필요 |
| ComplexFuncBench | Feasibility audit | dataset·Booking RapidAPI·BGE embedding·GPT-4o comparator/judge 필요, repository license 미표기 |
| ToolBench | Feasibility audit | ToolBench/RapidAPI server 또는 key와 ChatGPT ToolEval judge 필요 |
| StableToolBench | Feasibility audit | MirrorAPI/cache simulator와 judge model 및 별도 service setup 필요 |
| AppWorld | Feasibility audit | protected bundle·stateful 457-API world·DB evaluation 및 per-task orchestration 필요 |
| VAKRA | Feasibility audit | 약 35GB data, 8GB+ container memory, local API/RAG stack; CC BY-NC-SA 4.0 조건 |

이 제외는 해당 benchmark가 중요하지 않다는 뜻이 아니다. 이번 결과의 primary claim을 credential·judge·대규모 environment에 의존하지 않는 재현 가능한 protocol conversion 비교로 제한하기 위한 경계다.

## Implications

### 단기

- Native가 허용되는 endpoint에서는 별도 text middleware를 기본으로 둘 실익이 작다. 두 정적 패널에서 가장 높은 accuracy를 보였고 MCPMark에서도 8/10으로 가장 강했다. BFCL에서는 mean token이 가장 적었으며 ACE에서는 p50 latency가 가장 짧았다.
- Native tool calling을 사용할 수 없거나 text-only transport가 필요한 정적·단일턴 경로에서는 Morph XML이 가장 강한 fallback 후보다. 다만 MCPMark 0/10이므로 실제 multi-turn agent에 배포하기 전 별도 execution gate를 통과해야 한다.
- Sijawara는 모델 prompt tuning보다 parser 수정이 먼저다. 현재 점수로 protocol 설계 자체를 평가하면 parser defect와 모델 능력을 혼동하게 된다.
- YAML XML, Hermes는 markup leak/parser error에 대한 회귀 테스트가 필요하다. Qwen3Coder는 parser 문법 불일치, UI-TARS는 multi-turn 중간 종료와 높은 context token을 우선 점검해야 한다.

### 장기

- Benchmark scorer가 관대한 문자열 표준화나 substring matching을 수행하면 protocol corruption이 숨을 수 있다. semantic score와 transport/protocol-strict score를 항상 함께 보존해야 한다.
- 단일 aggregate accuracy만으로 middleware를 선택하면 category별 conversion loss와 recovery를 놓친다. paired outcome, language split, latency/token 및 integrity를 함께 운영 지표로 삼는 것이 좋다.
- MCPMark Easy에서 multi-turn tool-result round trip과 state mutation을 추가하자 정적 패널의 작은 protocol 차이가 큰 end-to-end 격차로 증폭됐다. 다음 단계는 127-task Verified suite, 반복 trial 및 실제 업무 도메인 환경으로 범위를 넓히는 것이다.

## Recommendations

### Priority 1: Native를 기본 경로로 유지

- **What:** endpoint가 native tool calling을 안정적으로 지원하면 Native를 production default로 사용한다.
- **Why:** BFCL 공동 1위이면서 category-macro는 가장 높고 ACE strict도 1위이며 MCPMark Easy도 8/10으로 1위다. BFCL mean token은 최소였고, `strict accuracy / mean token`의 단순 quality-efficiency 비율도 두 정적 패널에서 가장 높았다.
- **How:** Native availability와 malformed argument rate를 별도 SLO로 모니터링하고, provider-native schema 변경 시 regression panel을 재실행한다.

### Priority 2: Morph XML을 정적 text-only fallback 후보로 제한

- **What:** Native 불가 환경의 single-turn fallback 후보를 Morph XML로 두되, multi-turn agent 경로에는 별도 승인 gate를 둔다.
- **Why:** BFCL micro 동률, ACE에서 가장 가까운 middleware였지만 MCPMark Easy는 0/10이었다.
- **How:** markup leak 10건과 약 39%의 BFCL token overhead를 줄이고, `live_parallel_multiple`·`live_relevance` category 및 tool-result round trip을 집중 보강한다. MCPMark regression subset을 통과하기 전에는 stateful production fallback으로 승격하지 않는다.

### Priority 3: Sijawara XML value parser 수정

- **What:** XML pretty-print indentation이 text node value에 합쳐지지 않도록 parser를 수정한다.
- **Why:** BFCL 284/290행과 ACE 63/55행에서 boundary whitespace가 관측됐고 strict score를 지배했다.
- **How:** string, nested object, list, empty string, 의도적 whitespace를 포함한 fixture를 추가한다. 전체 string을 무조건 trim하지 말고 syntax formatting과 payload를 구분한다.

### Priority 4: Protocol integrity regression gate 추가

- **What:** semantic checker 외에 parser error, malformed args, markup leak, boundary whitespace 및 missing call을 CI 지표로 고정한다.
- **Why:** ACE-checker semantic만 보면 Sijawara Concise가 72%로 보이지만 strict는 26%다.
- **How:** 이 리포트의 BFCL/ACE SHA panel과 MCPMark Easy task를 작은 regression subset으로 축약해 PR별로 실행하고, full panel은 release 전 실행한다. semantic accuracy와 official verifier pass를 별도 gate로 유지한다.

## Limitations & Open Questions

- 한 endpoint, 한 model ID, 한 날짜의 snapshot이다. backend routing, quantization, cache 및 serving revision은 외부에서 확인할 수 없다.
- Temperature 0의 단일 trial이다. 스모크와 본 실행에서 같은 MCPMark task 결과가 달라진 사례가 있어 backend 또는 generation 비결정성이 남아 있음을 확인했지만 반복 trial로 분산을 추정하지는 않았다.
- Wilson interval은 각 custom panel의 binomial uncertainty를 나타낼 뿐 benchmark 전체 universe나 production traffic에 대한 보장을 뜻하지 않는다. 특히 MCPMark는 arm당 n=10이라 구간이 매우 넓다.
- BFCL·ACE는 custom inference setting이고 MCPMark도 adapted Easy loop이므로 공식 leaderboard와 직접 비교할 수 없다.
- Latency는 BFCL·ACE concurrency 16, MCPMark concurrency 8의 공유 부하 결과다. suite 간 실행 시점도 달라 절대 latency를 직접 비교하지 않았다.
- 가격 정보가 endpoint에서 제공되지 않아 monetary cost는 계산하지 않았다. token count만 보고했다.
- 실제 tool execution은 MCPMark Filesystem Easy 10개로만 측정했다. 127-task Verified suite, 다른 MCP service, user simulator, 장기 planning 및 현실적 권한·오류 환경까지 대표하지 않는다.

## Reproducibility & Validation

최종 산출물은 `benchmarks/glm-5.2-tool-calling/` 아래에 있다.

- BFCL result: `results/2026-07-17-bfcl-v4-sha256-40/`
- ACE result: `results/2026-07-17-ace-normal-static-sha256-5/`
- MCPMark result: `results/2026-07-17-mcpmark-filesystem-easy-1trial/`
- Runner/scorer/analyzer/validator: `src/run.ts`, `score_bfcl.py`, `src/analyze.ts`, `validate_bfcl.py`, `src/run-ace.ts`, `score_ace.py`, `analyze_ace.py`, `validate_ace.py`, `src/run-mcpmark.ts`, `analyze_mcpmark.py`, `validate_mcpmark.py`

검증 결과:

- BFCL: 3,648 expected/unique scored jobs, missing 0, unexpected 0, provider error 0, scorer error 0. Raw에는 transient HTTP 500 후 성공한 같은 job의 retry row 1개가 있어 물리적으로 3,649행이다.
- ACE: 800 expected/unique scored jobs, missing 0, unexpected 0, provider error 0, scorer error 0. Sampling 전 configured oracle-invalid exclusion은 8건이며, 최종 선택 패널에서 추가 oracle exclusion과 oracle-invalid case는 각각 0이다.
- MCPMark: 80 expected/unique jobs, missing 0, duplicate 0, unexpected 0, setup failure 0, secret pattern 0, raw SHA-256 일치. 이전 attempt provider timeout 3건은 모두 회복됐고 최종 미회복 infrastructure failure는 0이다.
- MCPMark 본 측정 metadata의 runner revision은 2다. 측정 후 독립 코드 감사에서 retry-failed row 교체, analyzer child-process credential scrubbing, MCP deadline 경계와 upstream prompt whitespace를 보강해 현재 harness를 revision 3으로 올렸다. 원본 raw·summary는 변경하지 않았고 configuration fingerprint가 revision 간 resume 혼합을 거부한다.
- Repository regression: 217 test files, 2,427 tests pass, type errors 0.
- Repository `pnpm check` 및 production build pass.

## 시각 자료

Notion 페이지의 각 결과 섹션 사이에 cross-suite accuracy, paired outcome, category/language heatmap, token efficiency, failure taxonomy, Sijawara sensitivity와 MCPMark success·task heatmap·execution footprint·failure composition 차트를 첨부했다.

## Sources

- [ai-sdk-tool-call-middleware @ d2e56ceb](https://github.com/minpeter/ai-sdk-tool-call-middleware/tree/d2e56ceb6302fe8028ea87ce7c945b92184779cd)
- [BFCL / Gorilla @ 6ea57973](https://github.com/ShishirPatil/gorilla/tree/6ea57973c7a6097fd7c5915698c54c17c5b1b6c8)
- [ACEBench @ 56dd66cf](https://github.com/chenchen0103/ACEBench/tree/56dd66cf6439b0d9655ee1b353e4cd745c6f664e)
- [MCPMark @ cd45b7f5](https://github.com/eval-sys/mcpmark/tree/cd45b7f57923b9b3985467f5139927575f83141c)
- [τ³-bench @ a1e85084](https://github.com/sierra-research/tau2-bench/tree/a1e85084a3960281cb06997594133e8f39ea42a7)
- [ToolSandbox @ 165848b9](https://github.com/apple/ToolSandbox/tree/165848b9a78cead7ca7fe7c89c688b58e6501219)
- [ComplexFuncBench @ c37b284e](https://github.com/zai-org/ComplexFuncBench/tree/c37b284e2f2e03ee456115b7c4b7e537f534be37)
- [ToolBench @ d56fdd89](https://github.com/OpenBMB/ToolBench/tree/d56fdd89faf8c91fa135090b212bb9057ee5cfc2)
- [StableToolBench @ aa4ed9f4](https://github.com/THUNLP-MT/StableToolBench/tree/aa4ed9f4737ad98bd706663f01d63623c3427812)
- [AppWorld @ a072b7a8](https://github.com/StonyBrookNLP/appworld/tree/a072b7a86e7c1d5b1d7175659d750ebb9b79f10a)
- [VAKRA @ 99847464](https://github.com/IBM/vakra/tree/99847464a7b0fca05413b53ad8a7714d9a9279e9)
