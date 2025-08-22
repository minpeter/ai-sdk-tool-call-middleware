## **Vercel AI SDK 모델 평가 도구 (Model Evaluation Tool) 제품 요구사항 문서 (PRD)**

### **1. 문서 정보**

* **문서명:** Vercel AI SDK 모델 평가 도구 (코드명: AI SDK Eval)
* **버전:** 1.1
* **작성자:** Gemini
* **최종 수정일:** 2025년 8월 23일
* **변경 사항:** v1.1 - BFCL 기본 벤치마크 추가, 설계 철학 및 구현 방향 구체화

### **2. 개요**

본 문서는 Vercel AI SDK 사용자들이 다양한 언어 모델(Language Model)의 성능을 **일관되고, 확장 가능하며, 재현 가능한 방식**으로 측정하고 비교할 수 있는 표준화된 벤치마킹 도구의 제품 요구사항을 정의합니다.

개발자들은 이 도구를 통해 특정 사용 사례(Use Case)에 가장 적합한 모델을 손쉽게 선택하고, 모델 업데이트나 설정 변경이 성능에 미치는 영향을 정량적으로 파악할 수 있습니다.

### **3. 설계 철학 및 원칙 (Vercel AI SDK 연동)**

본 평가 도구는 Vercel AI SDK의 핵심 설계 철학을 계승하고 확장해야 합니다. 모든 기능은 다음 원칙을 따라야 합니다.

1.  **단순성 및 사용 편의성 (Simplicity & Ease of Use):** 개발자가 최소한의 설정과 코드로 강력한 모델 평가를 수행할 수 있어야 합니다. 복잡한 설정이나 보일러플레이트를 요구해서는 안 됩니다.
2.  **통합된 인터페이스 (Unified Interface):** AI SDK가 다양한 모델 제공자(Provider)를 단일 인터페이스로 추상화하는 것처럼, 본 평가 도구 또한 **어떤 `LanguageModel` 인스턴스든** 동일한 방식으로 평가할 수 있어야 합니다. 특정 모델에 종속적인 평가 로직을 지양합니다.
3.  **확장성 및 구성 가능성 (Extensibility & Composability):** 기본 제공되는 벤치마크 외에도, 개발자가 자신만의 비즈니스 로직과 데이터셋을 사용하여 손쉽게 커스텀 벤치마크를 제작하고 공유할 수 있는 구조를 제공해야 합니다.

### **4. 문제 정의**

현재 Vercel AI SDK 생태계 내에서 언어 모델의 성능을 평가하는 것은 파편화되어 있으며 많은 수작업을 요구합니다. 개발자들은 다음과 같은 어려움에 직면해 있습니다.

1.  **표준의 부재:** 여러 모델(e.g., Gemma, Llama, GPT)을 동일한 조건에서 비교할 수 있는 표준화된 평가 프레임워크가 없습니다.
2.  **커스텀 평가의 어려움:** '한국어 능력', '코드 생성', '특정 도메인 지식' 등 자신만의 기준으로 모델을 평가하려면 매번 별도의 스크립트와 평가 로직을 처음부터 구현해야 합니다.
3.  **반복적인 테스트의 비효율:** 모델의 설정(e.g., `temperature`, `retries`)을 변경하며 성능을 비교하는 A/B 테스트 과정이 번거롭고 많은 보일러플레이트 코드를 필요로 합니다.
4.  **결과 분석의 복잡성:** 평가 결과를 한눈에 비교하고 분석하기 쉬운 형태로 시각화하거나 리포팅하기 어렵습니다.

### **5. 목표 및 성공 지표**

#### **목표**

* **표준화:** 개발자가 여러 모델과 설정을 손쉽게 비교할 수 있는 공통 벤치마크 인터페이스를 제공합니다.
* **확장성:** 개발자가 자신만의 특정 요구사항에 맞는 커스텀 벤치마크를 간단하게 정의하고 추가할 수 있도록 지원합니다.
* **자동화:** 모델, 설정, 벤치마크의 조합(Matrix)에 대한 평가 프로세스를 자동화하여 반복적인 작업을 최소화합니다.
* **결과 가시성:** 평가 결과를 Markdown, JSON 등 다양한 형식의 명확한 리포트로 제공하여 분석을 용이하게 합니다.

### **6. 핵심 기능 및 요구사항**

#### **FR-1: 커스텀 벤치마크 정의 인터페이스 (`LanguageModelV2Benchmark`)**

사용자가 자신만의 평가 로직을 구현할 수 있는 표준화된 타입스크립트 인터페이스를 제공합니다. (기존 내용과 동일)

* **속성:** `name`, `version`, `description`
* **메서드:** `run(model: LanguageModel, config?: Record<string, any>): Promise<BenchmarkResult>`
* **반환 타입 (`BenchmarkResult`):** `score`, `success`, `metrics`, `logs?`, `error?`

---

#### **FR-2: 통합 평가 실행 함수 (`evaluate`)**

정의된 벤치마크와 평가 대상을 조합하여 전체 평가를 실행하고 결과를 집계하는 핵심 함수를 제공합니다. (기존 내용과 동일)

* **인자 (`EvaluateOptions`):** `matrix`, `benchmarks`, `reporter?`
* **동작:** `matrix` 조합 생성, 벤치마크 실행, 결과 집계 및 리포팅

---

#### **FR-3: 결과 리포터 (Reporter)**

평가 결과를 다양한 형식으로 출력하여 사용자가 쉽게 분석하고 공유할 수 있도록 지원합니다. (기존 내용과 동일)

* **지원 형식:** Markdown, JSON, Console

---

#### **FR-4: 내장(Built-in) 벤치마크 제공**

사용자가 바로 사용할 수 있는 일반적인 목적의 벤치마크 몇 가지를 기본으로 제공합니다.

* **`summarization`:** 장문 요약 능력 평가
* **`json-generation`:** 스키마에 맞는 JSON 생성 능력 평가
* **`berkeley-function-calling-leaderboard` (BFCL) (신규 추가):** 모델의 함수 호출(Function Calling) 능력을 종합적으로 평가하는 업계 표준 벤치마크입니다.

#### **BFCL 벤치마크 구현 방향**

BFCL은 복잡하고 체계적인 평가 로직을 가지고 있지만, 이를 AI SDK Eval 도구의 철학에 맞게 통합해야 합니다.

1.  **AI SDK 설계 철학 준수:**
    * **통합 인터페이스 활용:** BFCL의 기존 `model_handler` 디렉토리 내에 있는 `api_inference`, `local_inference` 등 **개별 모델 제공자별 핸들러들을 모두 제거**합니다.
    * 대신, `LanguageModelV2Benchmark` 인터페이스의 `run` 함수가 받는 **`model: LanguageModel` 객체를 유일한 모델 호출 창구로 사용**합니다. 이를 통해 Vercel AI SDK가 지원하는 모든 모델(현재 및 미래)을 별도의 핸들러 구현 없이 BFCL 벤치마크로 평가할 수 있게 됩니다. 이것이 본 도구의 핵심 가치입니다.

2.  **구현 대략도:**
    * `bfclBenchmark` 객체의 `run` 메서드 내에서 BFCL의 평가 프로세스를 캡슐화합니다.
    * **데이터셋 로딩:** `bfcl_eval/data/` 디렉토리에 있는 표준 평가 데이터셋(e.g., `BFCL_v3_live_parallel.json`)을 로드합니다.
    * **프롬프트 생성 및 모델 호출:** 로드된 데이터셋의 각 테스트 케이스에 대해 프롬프트를 구성하고, `model.doGenerate()` 또는 `model.doStream()`을 호출하여 모델의 함수 호출 결과를 얻습니다.
    * **평가 및 채점:** BFCL의 핵심 평가 로직(`bfcl_eval/eval_checker/`)을 활용하여 모델의 응답과 `possible_answer` 내의 정답을 비교합니다. `ast_checker`, `multi_turn_checker` 등의 로직이 이 단계에서 실행됩니다.
    * **결과 매핑:** BFCL 평가 결과(e.g., 정확도, 성공률)를 `BenchmarkResult` 객체의 `score`, `success`, `metrics` 필드에 맞게 매핑하여 반환합니다.

### **7. 향후 고려사항 (Future Scope)**

* **결과 시각화 대시보드:** 평가 결과를 차트와 그래프로 보여주는 웹 기반 UI 제공.
* **벤치마크 레지스트리:** 커뮤니티가 만든 벤치마크를 공유하고 검색할 수 있는 중앙 허브 구축.
* **CI/CD 연동:** GitHub Actions 등과 연동하여 새로운 모델이 릴리즈되거나 프롬프트가 변경될 때마다 자동으로 성능 평가를 실행하는 기능.

### **8. 중요 참고사항**

> ❗️ 본 문서에 포함된 코드 예시는 **도구의 핵심 아이디어와 사용 흐름을 보여주기 위한 것**이며, 실제 구현 시 세부적인 API 디자인이나 인터페이스 구조는 변경될 수 있습니다. 이는 엄격한 명세가 아닌, 개발 방향을 제시하는 가이드라인입니다.





vercel ai sdk 의 languagemodel를 벤치마크 할 수 있는 공통 인터페이스를 구현.


```ts
import { LanguageModelV2Benchmark, BenchmarkResult } from './interfaces';
import { LanguageModel } from 'ai';

// bfcl 벤치마크 로직을 인터페이스에 맞게 구현
export const bfclBenchmark: LanguageModelV2Benchmark = {
  name: 'bfcl',
  version: '1.2.0',
  description: '모델의 함수 호출(Function Calling) 능력을 평가합니다.',

  async run(model: LanguageModel, config: Record<string, any> = {}): Promise<BenchmarkResult> {
    try {
      // 1. 여기에 실제 평가 로직 구현
      //    - 표준화된 데이터셋을 가져오고
      //    - 모델에 프롬프트를 보내 함수 호출 결과를 받고
      //    - 예상 결과와 비교하여 점수 계산
      const calculatedScore = 0.92; // 예시 점수
      const accuracy = 0.95;
      const f1 = 0.89;

      // 2. 표준화된 결과 객체 형태로 반환
      return {
        score: calculatedScore,
        success: calculatedScore > 0.8, // 성공 기준: 0.8 이상
        metrics: {
          accuracy,
          f1_score: f1,
        },
        logs: ['Test case 1 passed...', 'Test case 2 passed...'],
      };
    } catch (e) {
      return {
        score: 0,
        success: false,
        metrics: {},
        error: e as Error,
      };
    }
  },
};
```

이런 느낌으로 뭔가 커스텀 벤치마크를 정의할 수 있게 되고

```ts
import { LanguageModelV2Benchmark, BenchmarkResult } from '@ai-sdk-tool/eval';
import { LanguageModel } from 'ai';

// 벤치마크 1: 한국어 능력 평가
export const koreanProficiency: LanguageModelV2Benchmark = {
  name: 'korean-proficiency',
  version: '1.0.0',
  description: '모델의 한국어 이해 및 생성 능력을 평가합니다.',
  async run(model: LanguageModel): Promise<BenchmarkResult> {
    // ... 한국어 질문/답변 데이터셋으로 평가하는 로직 ...
    const score = 0.88; // 평가 결과 점수 (예시)
    return {
      score,
      success: score > 0.8,
      metrics: { '정확도': 0.9, '유창성': 0.85 },
    };
  },
};

// 벤치마크 2: 코딩 능력 평가
export const codingAbility: LanguageModelV2Benchmark = {
  name: 'coding-ability',
  version: '1.1.0',
  description: '모델의 코드 생성 및 디버깅 능력을 평가합니다.',
  async run(model: LanguageModel): Promise<BenchmarkResult> {
    // ... LeetCode 스타일 문제로 평가하는 로직 ...
    const score = 0.75; // 평가 결과 점수 (예시)
    return {
      score,
      success: score > 0.7,
      metrics: { '문제 해결률': 0.8, '코드 효율성': 0.7 },
    };
  },
};
```


이렇게 정의한 벤치마크를 evaluate 함수를 통해 구동하여 



```ts
import { evaluate } from '@ai-sdk-tool/eval';
import { openrouter } from 'ai/providers/openrouter';
import { koreanProficiency, codingAbility } from './my-benchmarks'; // 1단계에서 만든 벤치마크 import

console.log('모델 비교 평가를 시작합니다...');
const results = await evaluate({
  // 👇 비교할 대상을 matrix로 정의
  matrix: {
    // 모델 2종 비교
    model: [
      openrouter("google/gemma-3-9b-it"),
      openrouter("google/gemma-3-27b-it"),
    ],
    // 설정 2종 비교
    config: [
      { name: '빠른 응답 (재시도 없음)', retries: 0 },
      { name: '안정적 응답 (재시도 2회)', retries: 2 },
    ],
  },
  benchmarks: [koreanProficiency, codingAbility],
  reporter: 'markdown', 
});

console.log('평가 완료!');
```


평가 할 수 있게 됨.