# 🌐 MiniCDN — Distributed Content Delivery Network & Telemetry System

[![Node.js](https://img.shields.io/badge/Node.js-v18%2B-339933?style=flat&logo=node.js)](https://nodejs.org/)
[![Docker Compose](https://img.shields.io/badge/Docker%20Compose-v2%2B-2496ED?style=flat&logo=docker)](https://www.docker.com/)
[![Redis](https://img.shields.io/badge/Redis-v7.0-DC382D?style=flat&logo=redis)](https://redis.io/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-v15-4169E1?style=flat&logo=postgresql)](https://www.postgresql.org/)
[![License](https://img.shields.io/badge/License-MIT-blue.style=flat)](LICENSE)

**MiniCDN** is a production-grade, multi-tier distributed Content Delivery Network (CDN) engineered in Node.js, Express, Redis, PostgreSQL, and Docker. Designed to simulate enterprise CDN architectures (such as Cloudflare or Akamai), MiniCDN provides ultra-low latency static asset delivery, proactive popularity-based asset replication, $O(1)$ Least-Recently-Used (LRU) cache eviction, request coalescing to prevent cache stampedes, and seamless dual-persistence fallback resilience.

---

## 📐 System Architecture

```
                                 +-----------------------------------+
                                 |   Operations & Telemetry UI       |
                                 |      (http://localhost:3000)      |
                                 +-----------------------------------+
                                                   |
                                                   v
                                       +-----------------------+
                                       |   Load Balancer (LB)  |
                                       |      (Port 3000)      |
                                       +-----------------------+
                                            /      |      \
                                 Round-Robin / Health Failover / Overrides
                                          /        |        \
                                         v         v         v
                                  +--------+  +--------+  +--------+
                                  | Edge 1 |  | Edge 2 |  | Edge 3 |
                                  | (3001) |  | (3002) |  | (3003) |
                                  +--------+  +--------+  +--------+
                                      |           |           |
                                 Cache Miss   Cache Miss   Cache Miss
                                      \           |           /
                                       v          v          v
                                      +------------------------+
                                      |     Origin Server      |
                                      |      (Port 4000)       |
                                      +------------------------+
                                               /      \
                                              v        v
                                     +------------+  +------------+
                                     | PostgreSQL |  |   Redis    |
                                     | (Port 5432)|  | (Port 6379)|
                                     +------------+  +------------+
```

---

## 🔥 Key Engineering Highlights

### 1. High-Throughput Routing & Failover Load Balancing (`lb/`)
- **Round-Robin Distribution:** Evenly balances incoming asset requests across active edge nodes.
- **Heartbeat & Failover Monitoring:** Continuously tracks edge node health pings (15s interval via Redis/HTTP). If an edge node degrades or crashes, the Load Balancer automatically routes around it without client intervention.
- **Targeted Edge Routing:** Supports `X-Force-Edge-Id` headers to allow latency benchmarking tools and diagnostic clients to pin requests to specific edge nodes while maintaining HTTP Keep-Alive connection pools.

### 2. Intelligent Edge Cache Engine (`edge/`)
- **Cache-or-Fetch Loop:** Serves warm cache hits directly from local disk/RAM in **$\sim 15\text{ms} - 20\text{ms}$**. On a cold miss, streams the file from Origin while concurrently saving to edge disk and serving the client.
- **$O(1)$ LRU Cache Eviction (`edge/lru.js`):** Enforces strict disk capacity limits (`MAX_CACHE_FILES`). When capacity is reached, it uses a Redis-backed recency map to identify and purge the least recently accessed files.
- **Request Coalescing (Thundering Herd Protection):** Employs an in-flight promise map (`inFlightFetches`) on edge nodes. If 100 concurrent requests arrive simultaneously for an uncached asset, **only 1 request fetches from Origin** while the remaining 99 await the shared buffer.

### 3. Proactive Popularity Replication (`shared/replication.js`)
- Tracks per-asset global request metrics in real time.
- When an asset's download count crosses a threshold (`REPLICATION_THRESHOLD`, default 20), MiniCDN triggers an asynchronous replication push, proactively replicating the file to all remaining edge nodes before organic misses occur.

### 4. Zero-Downtime Dual-Persistence Fallback (`shared/redis.js` & `shared/db.js`)
- **Redis Resilience:** If Redis experiences an outage, `shared/redis.js` seamlessly transitions to local atomic IPC file state management (`.redis_state.json`). A background health task pings Redis every 15 seconds and automatically resynchronizes state upon recovery.
- **PostgreSQL Resilience:** If PostgreSQL goes offline, `shared/db.js` catches connection exceptions and falls back to local disk state (`.db_state.json`), maintaining continuous CDN operation.

---

## 📊 System Performance & Benchmark Results

MiniCDN includes an automated **Latency Benchmark Suite** (`benchmark/latency_benchmark.js`) that measures cold miss versus hot hit performance across $N=50$ sample files with HTTP Keep-Alive socket pooling and connection warm-up.

### Benchmark Performance Summary

| Metric | Origin Cold Miss | Edge Hot Cache Hit | Performance Gain |
| :--- | :---: | :---: | :---: |
| **Average Latency** | **$65.8\text{ms} - 80.2\text{ms}$** | **$18.4\text{ms} - 22.1\text{ms}$** | **$\sim 70\% - 75\%$ Latency Reduction** |
| **Throughput Factor** | $1.0\times$ baseline | **$3.5\times - 4.0\times$ faster** | **Instant Hot Hit Delivery** |

### Verification Test Suite Matrix

The benchmark suite dynamically validates 6 statistical and operational test assertions:

| Test Case | Description | Verification Logic | Status |
| :--- | :--- | :--- | :---: |
| **B.1** | **Clean State Verification** | Edge disk caches, Redis recency maps, and DB logs reset before run | `PASS` |
| **B.2** | **Genuine Miss Pass** | 100% of Step 3 requests return `X-Cache-Status: MISS` | `PASS` |
| **B.3** | **Genuine Hit Pass** | 100% of Step 4 requests return `X-Cache-Status: HIT` | `PASS` |
| **B.4** | **Hit < Miss Latency** | Average Hit Latency is strictly lower than Average Miss Latency | `PASS` |
| **B.5** | **Server Log Cross-Check** | Client latency correlates with PostgreSQL `request_logs` | `PASS` |
| **B.6** | **Result Stability** | Low latency variance ($\sigma < 0.75 \times \text{avg}$) across repeated sample runs | `PASS` |

---

## 🛠️ Microservice Directory Structure

```
Content_Delivary_Network/
├── benchmark/               # Performance & latency benchmark suite
│   ├── latency_benchmark.js # Automated 6-step N=50 latency benchmark engine
│   ├── results.json         # Structured JSON benchmark results
│   └── RESULTS.md           # Generated Markdown benchmark report
├── dashboard/               # Web Operations & Telemetry Dashboard
│   └── index.html           # Real-time Chart.js dashboard & traffic generator
├── edge/                    # Distributed Edge Cache Nodes
│   ├── lru.js               # O(1) LRU eviction algorithm
│   └── routes/              # Edge routes (fetch, receive, stats, purge)
├── lb/                      # Load Balancer Router & Health Monitor
│   └── routes/              # LB routes (router, stats aggregation, benchmark runner)
├── origin/                  # Master Origin Server
│   └── routes/              # Origin routes (upload, file retrieval, top-files)
├── shared/                  # Infrastructure Datastores & Cluster Services
│   ├── cluster.js           # Docker & Local environment target resolver
│   ├── db.js                # PostgreSQL pool with .db_state.json fallback
│   ├── redis.js             # Redis client with .redis_state.json fallback
│   └── replication.js       # Popularity replication engine
├── tests/                   # Automated smoke & master integration test suite
│   └── smoke_test_master.js # Master runner executing 35 end-to-end tests
├── docker-compose.yml       # Microservices orchestration (7 services)
├── init.sql                 # PostgreSQL database initialization script
├── Dockerfile               # Node.js production container image
└── README.md                # System documentation
```

---

## 🚀 Quickstart & Local Setup

### Prerequisites
- [Docker](https://www.docker.com/) and [Docker Compose](https://docs.docker.com/compose/) (v2.0+)
- [Node.js](https://nodejs.org/) (v18+ recommended for local test runners)

### 1. Clone & Launch Cluster
Spin up the entire 7-container microservice cluster with a single command:
```bash
git clone https://github.com/pKm720/MiniCDN.git
cd MiniCDN
docker compose up -d
```

Verify all containers are running:
```bash
docker compose ps
```

### 2. Access Web Telemetry Dashboard
Open your browser and navigate to:
```
http://localhost:3000/dashboard/
```
From the interactive dashboard, you can:
- **Upload Demo Files** directly to the Origin server.
- **Simulate Traffic** across the edge cluster.
- **Run the Latency Benchmark Suite** ($N=50$) with live speedup modal output.
- **Perform Reset Telemetry** (clears graphs) or **System Deep Purge** (clears disk caches and database states).

---

## 🧪 Running Automated Tests

MiniCDN features a comprehensive **35-test master smoke test suite** covering all core cache, replication, eviction, failover, and metrics capabilities.

To run the master test suite locally:
```bash
# Stop background Docker containers to release local ports
docker compose down

# Execute the 35-test master suite
node tests/smoke_test_master.js
```

Expected Output:
```
************************************************************************
       MINICDN — MASTER COMPREHENSIVE END-TO-END SYSTEM SUITE           
************************************************************************
  Phase 1 (13 Tests): 100% PASSED
  Phase 2 (12 Tests): 100% PASSED
  Phase 3 (10 Tests): 100% PASSED
************************************************************************
  🎉 ALL 35 TEST CASES ACROSS THE ENTIRE PROJECT PASSED 100%! 🎉
```

---

## ⚙️ Environment Variables Reference

Key environment variables configured in `.env` and `docker-compose.yml`:

| Variable | Default | Description |
| :--- | :---: | :--- |
| `PORT_LB` | `3000` | Port for the Load Balancer & Telemetry Router |
| `PORT_ORIGIN` | `4000` | Port for the Master Origin Server |
| `JWT_SECRET` | `supersecret-cdn-key` | Secret key for authenticating file upload requests |
| `MAX_CACHE_FILES` | `20` | Default LRU disk cache capacity per edge node |
| `REPLICATION_THRESHOLD` | `20` | Download count threshold to trigger proactive edge replication |
| `BENCHMARK_MODE` | `false` | Enables capacity headroom ($N=100$) during benchmark runs |

---

## 💡 System Design Trade-offs & Engineering Decisions

1. **Stream Piping vs. Buffer Holding:**
   On a cache miss, Edge nodes use `originRes.pipe(res)` to stream bytes directly to the client while simultaneously building an in-memory buffer (`chunks.push`). This minimizes Time-To-First-Byte (TTFB) without waiting for the full file to be written to disk.
2. **Atomic Response Completion:**
   `res.end()` is invoked in the `finally` block **after** `fs.writeFileSync()` and Redis metadata updates complete. This prevents race conditions where rapid subsequent requests might check disk before the file write finishes.
3. **Keep-Alive Socket Reuse for Benchmarks:**
   The latency benchmark routes Step 4 hit requests through the Load Balancer with `X-Force-Edge-Id` headers. This allows socket connection pooling (`keepAliveAgent`), isolating true CDN cache hit performance from TCP connection overhead.

---

## 📄 License
This project is licensed under the [MIT License](LICENSE).
