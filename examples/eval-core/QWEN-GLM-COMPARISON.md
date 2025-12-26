# Qwen3-30B-A3B vs GLM-4.6 Detailed Analysis

## Executive Summary

**결론**: GLM-4.6이 압도적으로 우수하며 production-ready
**권장**: Qwen3-30B-A3B는 시스템 프롬프트 개선 없이는 사용 불가

---

## Performance Comparison

### GLM-4.6: ⭐ EXCELLENT (99% Success Rate)

| Benchmark | Status | Failures |
|-----------|--------|----------|
| Simple | ✅ **PERFECT** | 0 |
| Multiple | ✅ **PERFECT** | 0 |
| Parallel | ⚠️ Near Perfect | 2 |
| Parallel-Multiple | ✅ **PERFECT** | 0 |

**Total Failures: 2 out of ~200 cases (~1% failure rate)**

### Qwen3-30B-A3B: ❌ CRITICAL ISSUES (~50% Failure Rate)

| Benchmark | Failures | Primary Issue |
|-----------|----------|---------------|
| Simple | 54 | Text responses, no XML |
| Multiple | 19 | Text responses, no XML |
| Parallel | 78 | Missing tool calls |
| Parallel-Multiple | 86 | Missing tool calls |

**Total Failures: 237 out of ~400 cases (~59% failure rate)**

---

## Root Cause Analysis

### 🔴 Qwen3-30B-A3B: Critical Prompt Following Issue

**Primary Problem: Model doesn't generate XML tool calls**

#### Failure Breakdown (117 parsing failures):
1. **86 cases (73%)**: No XML tags at all - pure text reasoning
2. **24 cases (20%)**: Incomplete/malformed XML
3. **7 cases (7%)**: Wrong XML format

#### Behavioral Patterns:
- **84/86 cases**: Reasoning extensively but NOT calling tool
- **75/86 cases**: Confused about tool usage
- **30/86 cases**: Attempting direct answer calculation

#### Example Failure:

**Expected:**
```xml
<solve_quadratic>
  <a>3</a>
  <b>-11</b>
  <c>-4</c>
  <root_type>all</root_type>
</solve_quadratic>
```

**Actual Output:**
```
Okay, I need to find all the roots of the quadratic equation
with coefficients a=3, b=-11, and c=-4. Let me think about
how to approach this.

First, the quadratic equation is ax² + bx + c = 0. The
standard method to solve this is using the quadratic formula:
x = [-b ± √(b² - 4ac)] / (2a)...

[continues with manual calculation for 20+ lines]
```

**Analysis**: Qwen is **reasoning about the problem** but **NOT executing the tool call**. This suggests:
1. System prompt doesn't emphasize tool calling strongly enough
2. Model may need explicit "MUST use tools" instruction
3. Possible training bias toward direct problem-solving

---

### 🟡 GLM-4.6: Rare Edge Case Failures

**Problem: Over-thinking complex parallel tasks**

#### Failure Cases (2 total):
1. `parallel_71`: Calculating derivatives - got confused about which derivative to calculate
2. `parallel_84`: Multiple displacement calculations - reasoning loop didn't conclude

#### Example (parallel_71):

**Expected:** 2 tool calls for derivatives
**Actual:** Long `<think>` reasoning about "should I calculate first derivative or second derivative first..." but never generated XML

**Analysis**: GLM-4.6 occasionally gets stuck in reasoning loops on **complex multi-step parallel tasks**, but this is VERY rare (2/~200 = 1%).

---

## Detailed Statistics

### Qwen3-30B-A3B Issues:

| Issue Type | Count | Percentage |
|------------|-------|------------|
| **Parsing Failures (0 calls)** | 117 | 49% of failures |
| **Incomplete (missing calls)** | 84 | 35% of failures |
| **Over-generation (extra calls)** | 36 | 16% of failures |

**Most Problematic Tools** (highest failure rates):
- `location`, `radius`: 5 failures each
- `calculate_return_on_equity`: 3 failures
- `case_id`: 3 failures
- `solve_quadratic`, `calculate_density`: 2 failures each

---

## Can Heuristics Fix These Issues?

### ❌ NO - Qwen's Issues Are NOT Parser Problems

**Qwen's failures are at the MODEL BEHAVIOR level:**
1. Model generates **pure text** instead of XML → Parser never receives XML to parse
2. Model **doesn't understand** it should call tools → No amount of XML repair can help
3. Model is **trained to solve problems directly** → Conflicts with tool-calling paradigm

**Heuristics CANNOT help because:**
- There's no malformed XML to repair
- There's no XML at all in 73% of failures
- The model fundamentally doesn't follow the "use tools" instruction

### ✅ Possible Solution: System Prompt Engineering

Qwen needs a MUCH STRONGER system prompt:

```
CRITICAL INSTRUCTION: You MUST use the provided tools to answer questions.
NEVER calculate or answer directly. ALWAYS use tools.

When a tool is available:
1. You MUST call it using XML format
2. DO NOT explain the calculation
3. DO NOT show your work
4. IMMEDIATELY output the XML tool call

Format: <tool_name><param>value</param></tool_name>
```

---

### ✅ YES - GLM's Issues Could Benefit from Heuristics

GLM-4.6's 2 failures are **reasoning loop timeouts**:
- Model generates correct `<think>` reasoning
- But gets stuck in analysis paralysis
- Never reaches XML generation

**Possible Heuristic:**
- Detect when `<think>` tag exceeds certain token length without closing
- Inject a "reminder" or truncate reasoning section
- Or: Adjust system prompt to limit reasoning length

But this is **very low priority** given only 2 failures.

---

## Recommendations

### ✅ PRODUCTION USE: GLM-4.6

**Why:**
- 99% success rate across all benchmarks
- 100% success on Simple, Multiple, Parallel-Multiple
- Only 2 edge-case failures in Parallel
- Native reasoning support with `<think>` tags
- Consistent XML generation

**Setup:**
```typescript
const glm = wrapLanguageModel({
  model: friendli("zai-org/GLM-4.6"),
  middleware: [
    createToolMiddleware({ protocol: morphXmlProtocol }),
    extractReasoningMiddleware({ tagName: "think" }),
  ],
});
```

---

### ❌ NOT RECOMMENDED: Qwen3-30B-A3B (Without Fixes)

**Why:**
- 59% failure rate - unacceptable for production
- Fundamental prompt-following issue
- Model doesn't understand tool calling paradigm
- Would require extensive system prompt engineering

**If You MUST Use Qwen:**
1. Rewrite system prompt with STRONG emphasis on tool calling
2. Test with at least 100 cases to verify improvement
3. Add fallback error handling for text-only responses
4. Consider it experimental, not production-ready

---

## Action Items

### ✅ Immediate:
1. **Use GLM-4.6 as primary model** for morphXML-based tool calling
2. **Exclude Qwen3-30B-A3B** from production recommendations
3. **Document GLM-4.6's 2 edge cases** as known limitations

### 💡 Future Work (Optional):
1. **Test improved system prompts for Qwen** to see if behavior changes
2. **Add reasoning timeout detection** for GLM (low priority)
3. **Monitor GLM-4.6 on more parallel cases** to understand the 2 failures

### ❌ Don't Do:
1. **Don't add parser heuristics for Qwen** - won't help
2. **Don't try to "repair" text-only responses** - model issue, not parser issue
3. **Don't recommend Qwen** without extensive prompt engineering first

---

## Conclusion

**The evaluation proves:**
1. ✅ morphXML protocol works excellently with **GLM-4.6** (99% success)
2. ❌ Qwen3-30B-A3B has **fundamental prompt-following issues** (59% failure)
3. ✅ GLM-4.6 is **production-ready** with minimal edge cases
4. ❌ Parser heuristics **cannot fix model behavior problems**

**Next Step:** Deploy with GLM-4.6 and monitor performance in production.
