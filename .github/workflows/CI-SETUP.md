# CI 회귀 테스트 설정 가이드

이 문서는 regression-tests.yml 워크플로우 설정 방법을 설명합니다.

## 📋 필수 환경 변수

### FRIENDLI_TOKEN

**설명**: Friendli API 접근을 위한 인증 토큰

**설정 방법**:

#### 1. Secret으로 설정 (권장)
```
Settings > Secrets and variables > Actions > New repository secret

Name: FRIENDLI_TOKEN
Value: your_friendli_api_token_here
```

#### 2. Variable로 설정 (비공개 레포에서만)
```
Settings > Secrets and variables > Actions > Variables > New repository variable

Name: FRIENDLI_TOKEN
Value: your_friendli_api_token_here
```

**Secret vs Variable**:
- **Secret**: 암호화됨, 로그에 표시 안 됨 (권장)
- **Variable**: 평문, 로그에 표시됨 (비공개 레포에서만 사용)

### 토큰 발급 방법

1. [Friendli Console](https://console.friendli.ai/) 접속
2. Settings > API Keys 이동
3. "Create API Key" 클릭
4. 키 복사하여 GitHub Secrets에 추가

## 🎯 트리거 방식

### 1. PR 자동 실행 (기본)

**PR 생성 또는 커밋 추가 시 자동으로 실행됩니다.**

다음 파일 변경 시 자동 실행:
- `packages/parser/**`
- `packages/eval/**`
- `packages/middleware/**`

**모드**: Fast (4 categories x 5 cases = 20 케이스, ~2분)

**동작 과정**:
1. PR 생성 또는 커밋 푸시
2. CI가 자동으로 벤치마크 실행
3. 결과를 PR 코멘트로 게시

### 2. PR 댓글 트리거 (모드 변경)

자동 실행 외에 댓글로 다른 모드 실행 가능:

```bash
# Fast 모드 (20 케이스, ~2분) - 기본 댓글 트리거
/benchmark

# Full 모드 (전체 케이스, ~15분) - 최종 검증
/benchmark full
/benchmark all
```

**동작 과정**:
1. 댓글에 `/benchmark` 입력
2. 봇이 👀 리액션 추가 (작업 시작)
3. 벤치마크 실행 (GitHub Actions)
4. 결과를 PR 코멘트로 게시
5. 성공 시 🚀 리액션 추가

### 3. 수동 실행

```
Actions > Regression Tests > Run workflow

선택:
- Branch: 실행할 브랜치
- Mode: fast / full
```

### 4. Main 브랜치 자동 실행

다음 파일 변경 시 자동 실행:
- `packages/parser/**`
- `packages/eval/**`
- `packages/middleware/**`

**모드**: Full (전체 벤치마크)

## ⚡ 벤치마크 모드

| 모드 | 케이스 수 | 소요 시간 | API 호출 | 비용 | 사용 시점 |
|------|-----------|----------|---------|------|----------|
| **fast** ⚡ | 20 (4 categories x 5) | ~2분 | ~40 | 최소 | PR 자동, 빠른 검증 |
| **full** 🔥 | 400+ | ~15분 | ~800 | 보통 | 최종 검증, 베이스라인 |

### 모드별 벤치마크

- **fast**: bfcl-simple + bfcl-multiple + bfcl-parallel + bfcl-parallel-multiple (각 5개씩)
- **full**: bfcl-simple + bfcl-multiple + bfcl-parallel + bfcl-parallel-multiple (전체)

## 📊 결과 해석

### PR 코멘트 예시

```markdown
## 📊 Regression Benchmark Results

**Commit:** `abc1234`
**Branch:** `feature/my-feature`
**Model:** zai-org/GLM-4.6
**Mode:** ⚡ fast
**Time:** 2024-12-26 10:00:00

### Current Results
| Benchmark | Native | morphXML | Δ |
|-----------|--------|----------|---|
| bfcl-simple | 89.4% | 89.1% | -0.3% |

### 📈 Comparison with Main Branch
*Baseline: Average of last 5 results from main branch*

| Benchmark | Current Native | Baseline Native | Δ Native | ... |
|-----------|----------------|-----------------|----------|-----|
| bfcl-simple | 89.4% | 89.2% | ⚠️ +0.2% | ... |

### ✅ No Regression Detected
All benchmarks are within expected performance range (±2%)
```

### 아이콘 의미

- **⚡** fast 모드
- **🔥** full 모드
- **⚠️** 회귀 감지 (>2% 하락)
- **✨** 개선 (>2% 향상)
- **👀** 작업 시작
- **🚀** 작업 완료

## 🔄 데이터 관리

### 히스토리 파일

`.benchmark-results/history.jsonl`에 모든 결과 저장:
- **Git 추적**: ✅ (버전 관리됨)
- **형식**: JSON Lines (한 줄에 하나의 결과)
- **비교**: 같은 모드끼리만 비교

**예시**:
```json
{"commit":"abc1234","branch":"main","timestamp":"2024-12-26T10:00:00Z","model":"zai-org/GLM-4.6","mode":"fast","results":{"native":{"bfcl-simple":0.894},"morphxml":{"bfcl-simple":0.891}}}
```

### 개별 결과 파일

- **경로**: `.benchmark-results/benchmark-{hash}-{timestamp}.json`
- **Git 추적**: ❌ (무시됨)
- **보관**: CI 아티팩트로 90일간

## 🚨 문제 해결

### "No API token found" 에러

**원인**: FRIENDLI_TOKEN이 설정되지 않음

**해결**:
1. GitHub Settings > Secrets 확인
2. 토큰 이름이 정확히 `FRIENDLI_TOKEN`인지 확인
3. Secret 권한 확인

### 벤치마크가 실행 안 됨

**PR 댓글 트리거**:
- `/benchmark` 명령어 정확히 입력했는지 확인
- PR이 Fork에서 온 경우 보안상 실행 안 됨 (Fork PR에서는 Secret 접근 불가)

**Main 브랜치**:
- 변경된 파일이 `packages/parser`, `packages/eval`, `packages/middleware` 중 하나인지 확인
- Actions 탭에서 워크플로우 실행 확인

### 회귀 감지 (CI 실패)

**의미**: 베이스라인 대비 2% 이상 성능 하락

**대응**:
1. PR 코멘트에서 구체적인 수치 확인
2. 코드 변경이 의도된 것인지 검토
3. 의도된 하락이라면 무시 가능
4. 버그라면 수정 후 재실행

### 같은 모드끼리만 비교

- **fast vs full**: 비교 안 됨 ✅
- **fast vs fast**: 비교 가능 ✅
- **full vs full**: 비교 가능 ✅

**이유**: 테스트 케이스 수가 다르면 점수가 달라질 수 있음

## 💡 모범 사례

### PR 작성자

1. **일반 작업**: PR 생성/커밋 푸시 → 자동으로 fast 모드 실행 (별도 작업 불필요)
2. **최종 확인**: `/benchmark full` (머지 직전, 전체 벤치마크)

### 메인테이너

1. **일반 PR**: 자동 실행 결과 확인 (fast 모드)
2. **중요 변경**: `/benchmark full` 댓글로 전체 벤치마크 요청
3. **Main 머지**: 자동 실행됨 (full 모드, 별도 작업 불필요)

### 비용 관리

- **자동 실행**: Fast 모드로 기본 검증 (~40 API 호출)
- **Full**: 릴리스 전, 중요 변경사항 (`/benchmark full`)

## 📞 지원

문제가 지속되면:
1. GitHub Issues에 보고
2. Actions 로그 첨부
3. 에러 메시지 포함
