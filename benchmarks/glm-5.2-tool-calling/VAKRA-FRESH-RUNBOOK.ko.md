# VAKRA 5,207 × 2 fresh 실행 규약

## 고정 범위

- Code commit: `99847464a7b0fca05413b53ad8a7714d9a9279e9`
- Dataset revision: `1511b3a6ce0bb8df8aca2ae1b578510e150b6b7e`
- Task-set SHA-256: `7ec5c994f06feb43fce6f563e9fa890d2f3ebfa7547df7667b0375e196bbe539`
- 모집단: Capability 1 `2,077`, Capability 2 `1,597`, Capability 3 `869`, Capability 4 `664`; 합계 `5,207 tasks/arm`
- Arm: `glm52-native`, `glm52-native-plus`; 총 `10,414`개의 신규 model-under-test trajectory

과거 raw response, score, partial output, preseed, resume는 사용하지 않는다. 정상적인 agent error도 행을 삭제하지 않고 공식 분모에 유지한다. adapter나 bridge 자체 오류가 확인되면 해당 root 전체를 invalid 처리하고 새 root에서 다시 시작한다.

## 데이터와 환경 gate

1. `build_vakra_full_manifest.py --validate`로 code pin, dataset revision, 파일별 SHA-256과 행 수를 재검산한다.
2. `sync_vakra_pinned_dataset.py`만 사용해 pinned revision을 내려받는다. upstream `make download`는 revision을 고정하지 않으므로 사용하지 않는다.
3. host agent venv는 CPU-only `torch`를 사용한다. CUDA runtime은 benchmark semantics에 필요하지 않다.
4. Docker image는 `data/`를 포함하지 않고, 네 capability container가 동일 pinned snapshot을 read-only mount한다.
5. MCP checksum validation과 양 arm smoke가 모두 통과하기 전 full inference root를 만들지 않는다.

## Inference gate

Bridge는 model runner보다 먼저 떠야 하므로 capture를 별도 sibling `bridge-full-fresh-v1`에 0행부터 시작한다. `vakra_official_native.py`는 존재하지 않는 output root만 허용하고, root 생성 직후 이 sibling을 `full-fresh-v1/bridge` provenance link로 연결한다. `--bridge-root`가 full root 내부이거나 request/raw audit 파일이 없으면 실행을 거부한다.

Runner는 capability별로 두 arm을 함께 실행한다. 실행 뒤 `validate_vakra_official.py`가 다음을 모두 확인해야 한다.

- 각 arm `5,207`개 UUID exact coverage
- capability/domain file set exact match
- duplicate/missing UUID 0
- output과 `_tools.json`의 UUID parity
- 유효한 success/error status와 tool-call shape

이 validation이 `status=valid`를 반환하기 전에는 evaluator를 시작하지 않는다.

## 공식 judge의 transport adaptation

Upstream scorer와 judge prompt는 수정하지 않는다. Upstream `judge.py`가 기본 transport를 Groq URL로 고정하므로 `vakra_official_evaluate.py`가 런타임에서 `ChatModel` transport만 다음처럼 치환한다.

- Judge model: upstream 문서와 동일한 `openai/gpt-oss-120b`
- Endpoint: `https://freerouter.minpeter.workers.dev/v1`
- Temperature: upstream과 동일한 `0`
- 변경하지 않는 것: prompt, output parser, exact-match, correctness, groundedness, MCP replay, dialogue aggregation

Upstream checkout은 수정하지 않는다. wrapper는 scorer source hashes와 adapter hash를 기록하고, judge call 원문 대신 request/response SHA-256, byte length, latency, status만 `judge-call-receipts.jsonl`에 남긴다. provider key는 지정된 process environment에서만 읽고 artifact에는 기록하지 않는다.

Score root도 시작 시 존재하지 않아야 하며 score resume를 금지한다. `validate_vakra_scores.py`가 양 arm의 4개 capability, 모든 domain, `5,207` dialogue/arm, missing/extra 0, score range, secret-retention scan을 통과한 뒤에만 결과를 공개한다.
