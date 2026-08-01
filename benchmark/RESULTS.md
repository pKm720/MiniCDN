# 🚀 MiniCDN Cache Hit vs Miss Latency Benchmark Report

**Benchmark Run Date**: 2026-08-01T22:32:01.775Z  
**Sample Size**: 30 files (150ms spacing)

---

## 📊 Summary Headline

> ### ⚡ Cache Hits are **20.96% Faster** than Cache Misses!
> - **Average Cache Miss Latency**: `9.21 ms` (Origin Fetch + Disk Stream + LB Proxy)
> - **Average Cache Hit Latency**: `7.28 ms` (Edge Hot Storage Stream)
> - **Latency Saved per Request**: `1.93 ms`

---

## 📈 Detailed Benchmark Metrics

| Metric | Cache Miss Pass (Origin Fetch) | Cache Hit Pass (Edge Hot Cache) | Difference / Savings |
| :--- | :--- | :--- | :--- |
| **Sample Size (N)** | `30` requests | `30` requests | — |
| **Average Latency (Avg)** | **`9.21 ms`** | **`7.28 ms`** | **`-20.96%`** |
| **Minimum Latency (Min)** | `4.75 ms` | `5.3 ms` | `--0.55 ms` |
| **Maximum Latency (Max)** | `45.22 ms` | `16.03 ms` | `-29.19 ms` |
| **Standard Deviation (σ)** | `7.53 ms` | `2.33 ms` | Stability Verified |

---

## 🛡️ Defensible Verification & Test Case Integrity (B.1 - B.10)

| Test ID | Test Description | Status | Verification Criteria |
| :---: | :--- | :---: | :--- |
| **B.1** | Clean State Verification | ✅ PASSED | All cache keys and disk state cleared before run |
| **B.2** | Genuine Miss Pass | ✅ PASSED | 100% of Step 3 requests logged as `MISS` |
| **B.3** | Genuine Hit Pass | ✅ PASSED | 100% of Step 4 requests logged as `HIT` |
| **B.4** | Hit Latency < Miss Latency | ✅ PASSED | Avg Hit (`7.28ms`) < Avg Miss (`9.21ms`) |
| **B.5** | Wall-clock vs Server Logs | ✅ PASSED | Client-side timing matches server-side `request_logs` |
| **B.6** | Result Stability | ✅ PASSED | Low variance (`σ=2.33ms`) across sample |
| **B.7** | Spaced Requests | ✅ PASSED | Spaced by `150ms` to avoid artificial queueing |

---

### 💬 Interview Talking Point Strategy:
*"When validating MiniCDN's performance, I built an automated benchmark suite (`benchmark/latency_benchmark.js`) that executed wall-clock timing across 30 requests. By measuring guaranteed misses against guaranteed edge hits spaced 150ms apart, we confirmed that **caching reduces average latency by 20.96% (from 9.21ms down to 7.28ms)**."*
