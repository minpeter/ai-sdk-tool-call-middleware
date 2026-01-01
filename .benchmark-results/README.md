# Regression Benchmark Results

이 디렉토리는 자동화된 회귀 테스트 벤치마크 결과를 저장합니다.

## 📁 파일 구조

- `history.jsonl`: 모든 벤치마크 실행 결과의 히스토리 (JSONL 형식, git으로 추적됨)
- `benchmark-{hash}-{timestamp}.json`: 개별 벤치마크 실행 결과 (git에서 무시됨)
- `report.md`: 가장 최근 비교 리포트 (CI에서 생성, git에서 무시됨)
- `.gitkeep`: 빈 디렉토리 유지용 플레이스홀더

## 🔄 작동 방식

### 1. 트리거 방식

#### 자동 실행
- **PR 생성/커밋 시**:
  - Fast 모드 (4 categories x 5 cases = 20개) - 빠르고 저렴
  - parser/eval/middleware 패키지 변경시만
- **main 브랜치 푸시 시**:
  - Full 모드로 전체 벤치마크 실행
  - 베이스라인 데이터 업데이트
  - parser/eval/middleware 패키지 변경시만

#### 댓글 트리거
```bash
# Fast 모드 (20 케이스) - 기본
/benchmark

# Full 모드 (전체)
/benchmark full
```

#### 수동 실행
```bash
# GitHub Actions UI에서:
# Actions > Regression Tests > Run workflow
# - Fast 모드: 4 categories x 5 cases (빠르고 저렴)
# - Full 모드: 모든 벤치마크 (완전한 테스트)
```

#### 비용 절감 메커니즘
- ✅ Fast 모드 기본 (20 케이스만)
- ✅ 파일 경로 필터 (관련 파일만)
- ✅ Concurrency로 중복 실행 취소

### 2. 벤치마크 테스트
두 가지 설정으로 동일한 모델(GLM-4.6)을 테스트:
- **Native Tool Calling**: 네이티브 함수 호출 지원
- **morphXML Protocol**: XML 기반 도구 호출 프로토콜

다음 벤치마크를 실행:
- `bfcl-simple`: 단순 함수 호출
- `bfcl-multiple`: 다중 함수 호출
- `bfcl-parallel`: 병렬 함수 호출
- `bfcl-parallel-multiple`: 병렬 다중 함수 호출

### 3. 결과 비교
- main 브랜치의 마지막 5개 결과 평균을 베이스라인으로 사용
- 현재 결과와 베이스라인을 비교
- 2% 이상 성능 하락 시 회귀로 판단
- **같은 모드끼리만 비교** (fast vs fast, full vs full)

### 4. 리포트 생성
- 현재 결과와 베이스라인 비교를 포함한 마크다운 리포트 생성
- PR 코멘트로 자동 게시
- CI 아티팩트로 업로드

## 📊 결과 형식

### history.jsonl
각 줄은 하나의 벤치마크 실행 결과를 나타내는 JSON 객체:

```json
{
  "commit": "abc1234...",
  "branch": "feature/my-feature",
  "timestamp": "2024-12-26T10:00:00.000Z",
  "model": "zai-org/GLM-4.6",
  "mode": "fast",
  "results": {
    "native": {
      "bfcl-simple": 0.894,
      "bfcl-multiple": 0.826,
      "bfcl-parallel": 0.838,
      "bfcl-parallel-multiple": 0.815
    },
    "morphxml": {
      "bfcl-simple": 0.891,
      "bfcl-multiple": 0.823,
      "bfcl-parallel": 0.835,
      "bfcl-parallel-multiple": 0.812
    }
  }
}
```

## 🔧 수동 실행

### 로컬 실행
```bash
# Fast 모드 (4 categories x 5 cases, 가장 빠름)
BENCHMARK_MODE=fast FRIENDLI_TOKEN=your_token pnpm tsx scripts/run-regression-benchmarks.ts

# Full 모드 (전체 벤치마크)
BENCHMARK_MODE=full FRIENDLI_TOKEN=your_token pnpm tsx scripts/run-regression-benchmarks.ts

# 결과 비교
pnpm tsx scripts/compare-benchmarks.ts
```

### GitHub Actions에서 수동 실행
1. Actions 탭 이동
2. "Regression Tests" 워크플로우 선택
3. "Run workflow" 버튼 클릭
4. Fast/Full 모드 선택
5. Run 실행

### 비용 예상치
- **Fast 모드** (4 categories x 5 = 20): ~40 API 호출 (native + morphXML)
- **Full 모드** (4개 벤치마크 전체): ~800 API 호출 (native + morphXML)
- API 요금은 Friendli 기준이며, 모델에 따라 다름

## 📈 데이터 관리

- `history.jsonl`은 git으로 추적되어 프로젝트와 함께 버전 관리됨
- 개별 벤치마크 파일은 무시되지만 CI 아티팩트로 90일간 보관됨
- main 브랜치로 머지될 때 자동으로 히스토리 업데이트

## ⚠️ 주의사항

- 벤치마크 실행에는 API 토큰(FRIENDLI_TOKEN)이 필요
- 전체 벤치마크 실행은 약 15분 소요 (full 모드)
- 네트워크 상태나 API 응답 시간에 따라 결과가 약간 변동될 수 있음
- 2% 임계값은 이러한 변동을 고려한 값
- **같은 모드끼리만 비교됨** (모드별로 케이스 수가 달라 점수가 다를 수 있음)

## 🚀 미래 개선사항

- [ ] 더 많은 모델 추가 (예: Qwen, Llama, MiniMax)
- [ ] ComplexFuncBench 추가
- [ ] 시각화 대시보드
- [ ] 성능 트렌드 그래프
- [ ] 이메일/Slack 알림
