# 🚀 MiniCDN — Comprehensive Test Suite & Scenario Handbook

This document provides a complete guide to all **35 automated test cases** and **7 interactive dashboard scenarios** for the MiniCDN distributed architecture. It explains how to execute every scenario, what result to expect on the telemetry graph, and why the system behaves the way it does.

---

## 📋 Table of Contents
1. [Architecture Overview](#-architecture-overview)
2. [7 Interactive Dashboard Scenarios](#-7-interactive-dashboard-scenarios)
   - [Scenario 1: Cold Cache Request (100% MISS)](#scenario-1-cold-cache-request-100-miss)
   - [Scenario 2: Warm Cache Acceleration (High Hit Ratio)](#scenario-2-warm-cache-acceleration-high-hit-ratio)
   - [Scenario 3: Cold Cache Sweep (100% Red Bar)](#scenario-3-cold-cache-sweep-100-red-bar)
   - [Scenario 4: Proactive Popularity Replication](#scenario-4-proactive-popularity-replication)
   - [Scenario 5: Live LRU Cache Eviction](#scenario-5-live-lru-cache-eviction)
   - [Scenario 6: Edge Node Failure & Failover](#scenario-6-edge-node-failure--failover)
   - [Scenario 7: Edge Node Recovery & Re-Integration](#scenario-7-edge-node-recovery--re-integration)
3. [Master Automated Test Matrix (35/35 Passing)](#-master-automated-test-matrix-3535-passing)
4. [Telemetry & Graph Interpretation Guide](#-telemetry--graph-interpretation-guide)

---

## 🏛 Architecture Overview

MiniCDN is composed of **7 Docker microservices**:
- **Load Balancer (Port 3000)**: Round-robin routing, health monitoring, and telemetry collection.
- **Origin Server (Port 4000)**: Source-of-truth storage, JWT authentication, and popularity replication worker.
- **Edge Nodes (Ports 3001, 3002, 3003)**: Distributed reverse proxy caches with LRU eviction.
- **Redis (Port 6379)**: In-memory cache indexes, heartbeats, download counters, and fallback state storage.
- **PostgreSQL (Port 5432)**: Persistent file metadata, edge registry, and request log table.

---

## 🧪 7 Interactive Dashboard Scenarios

All scenarios can be executed via the live dashboard at **`http://localhost:3000/dashboard`**.

---

### Scenario 1: Cold Cache Request (100% MISS)

#### 🎯 Goal:
Demonstrate initial file fetching when an edge node does not yet hold a cached copy.

#### 🧪 Steps:
1. Click **`📤 1. Upload Demo File to Origin`** $\rightarrow$ Obtains `File ID: 1`.
2. Set File ID = `1`, Downloads N = `1`.
3. Click **`▶ 2. Fire N Requests`**.

#### 📊 Telemetry & Graph Result:
- **Hits**: `0`
- **Misses**: `1`
- **Chart.js**: Single Red Bar on Edge 1 (`100% Misses`).
- **Hit Ratio**: `0.0%`
- **Cache Footprint**: Edge 1 shows `ID: 1` cached (Disk Size ~46 bytes).

#### 💡 Explanation:
When File 1 is requested for the first time, Edge 1 checks its local cache. Finding nothing (Cache **MISS**), Edge 1 streams the file from the Origin server, returns it to the client, and saves a local copy on disk.

---

### Scenario 2: Warm Cache Acceleration (High Hit Ratio)

#### 🎯 Goal:
Demonstrate sub-millisecond edge cache acceleration on repeated file requests.

#### 🧪 Steps:
1. Set File ID = `1`, Downloads N = `25`.
2. Click **`▶ 2. Fire N Requests`**.

#### 📊 Telemetry & Graph Result:
- **Hits**: `24`
- **Misses**: `1` (or 3 across edges)
- **Chart.js**: Tall Green Bars across Edge 1, 2, and 3.
- **Hit Ratio**: **`92.0% – 96.0%`**

#### 💡 Explanation:
After the initial miss, Edge 1, 2, and 3 hold local cached copies. All subsequent requests are served directly from Edge disk/memory without making HTTP requests to Origin, resulting in a **~95% Green Bar** on the telemetry graph.

---

### Scenario 3: Cold Cache Sweep (100% Red Bar)

#### 🎯 Goal:
Demonstrate how a CDN behaves when users request a large catalog of brand-new uncached files.

#### 🧪 Steps:
1. Click **`📤 1. Upload Demo File`** 5 times (creates `File IDs 1, 2, 3, 4, 5`).
2. Fire **1 request** to File 1, **1 request** to File 2, **1 request** to File 3, **1 request** to File 4, **1 request** to File 5.

#### 📊 Telemetry & Graph Result:
- **Hits**: `0`
- **Misses**: `5`
- **Chart.js**: **100% RED BARS** across all 3 edge nodes.
- **Hit Ratio**: `0.0%`

#### 💡 Explanation:
Because every request target is a unique uncached file ID, every edge node must fetch from Origin. This simulates a "Cold Cache Sweep" or a new product launch where no edge has warm caches.

---

### Scenario 4: Proactive Popularity Replication

#### 🎯 Goal:
Demonstrate automatic background replication when a file crosses the popularity threshold ($\ge 20$ downloads).

#### 🧪 Steps:
1. Upload a new file $\rightarrow$ `File ID: 2`.
2. Fire 5 downloads to File 2.
   - *Check Table*: Status = **`Organic (Cached on 2 Edges via LB)`** in blue.
3. Fire 15 more downloads to File 2 (Total downloads = 20).

#### 📊 Telemetry & Graph Result:
- **Popularity & Replication Table**:
  - Download Count: `20`
  - Status updates live to **`⚡ Proactively Replicated (Threshold ≥ 20)`** in green!
  - Tags show: `edge-1, edge-2, edge-3`.

#### 💡 Explanation:
Origin tracks download counts in Redis. When File 2 reaches 20 downloads, Origin identifies it as "Viral/Popular" and **proactively pushes file bytes to Edge 1, Edge 2, and Edge 3** in the background, eliminating future misses.

---

### Scenario 5: Live LRU Cache Eviction

#### 🎯 Goal:
Demonstrate Least Recently Used (LRU) cache eviction when an edge node reaches its capacity limit (`MAX_CACHE_FILES = 3`).

#### 🧪 Steps:
1. Upload 4 files (`IDs 1, 2, 3, 4`).
2. Request File 1, File 2, File 3 (1 request each).
   - *Check Footprint Table*: Edges show `3 files` (`ID: 1, ID: 2, ID: 3`). Cache is FULL.
3. Fire 1 request to **File 4**.

#### 📊 Telemetry & Graph Result:
- **Edge Cache Footprint Table**:
  - `ID: 1` (the oldest/least recently used file) **instantly disappears**.
  - `ID: 4` takes its place $\rightarrow$ Cached files: `ID: 2, ID: 3, ID: 4`.
- Total files per edge **never exceeds 3**.

#### 💡 Explanation:
When File 4 is cached, Edge checks `MAX_CACHE_FILES = 3`. Finding the capacity full, it queries Redis timestamps, identifies File 1 as the oldest accessed file, unlinks `1` from disk, and inserts `4`.

---

### Scenario 6: Edge Node Failure & Failover

#### 🎯 Goal:
Demonstrate high availability and zero-downtime routing when an edge node crashes.

#### 🧪 Steps:
1. Stop Edge Node 1 in terminal:
   ```powershell
   docker stop minicdn-edge-1
   ```
2. Observe dashboard after ~15–20s.
3. Fire 15 downloads to File 1.

#### 📊 Telemetry & Graph Result:
- **Cluster Node Health**: Edge 1 dot turns **RED (`offline`)**.
- **Active Edges Badge**: Drops from `3/3` to **`2/3`**.
- **Traffic Success**: All 15 requests complete with `200 OK` (0 dropped requests).

#### 💡 Explanation:
Load Balancer's health monitor detects missed heartbeats (>25s) and removes Edge 1 from the round-robin active list. Requests are seamlessly routed between healthy Edge 2 and Edge 3.

---

### Scenario 7: Edge Node Recovery & Re-Integration

#### 🎯 Goal:
Demonstrate automatic self-healing when a failed edge node comes back online.

#### 🧪 Steps:
1. Start Edge Node 1:
   ```powershell
   docker start minicdn-edge-1
   ```
2. Observe dashboard on next refresh tick (~10s).

#### 📊 Telemetry & Graph Result:
- **Cluster Node Health**: Edge 1 dot turns **GREEN (`healthy`)**.
- **Active Edges Badge**: Restores to **`3/3`**.
- Round-robin routing automatically resumes distributing traffic across all 3 nodes.

#### 💡 Explanation:
Upon startup, Edge 1 resumes sending heartbeat PINGs to `POST /lb/heartbeat`. Load Balancer marks Edge 1 as `healthy` in PostgreSQL/Redis and re-includes it in traffic distribution.

---

## ⚙️ Master Automated Test Matrix (35/35 Passing)

Below is the verified automated test suite covering Phase 1, Phase 2, and Phase 3 requirements:

| Test ID | Test Category | Test Case Description | Expected Result | Status |
| :--- | :--- | :--- | :--- | :--- |
| **1.1** | Phase 1: Origin | Valid JWT File Upload (`POST /origin/upload`) | `201 Created` with File ID & SHA256 Hash | `PASS` |
| **1.2** | Phase 1: Origin | Missing/Invalid JWT Auth Token | `401 Unauthorized` | `PASS` |
| **1.3** | Phase 1: Origin | Duplicate File Hash Handling | Returns existing File Metadata | `PASS` |
| **1.4** | Phase 1: Origin | Direct Metadata Retrieval (`GET /origin/file/:id`) | Returns JSON metadata & download count | `PASS` |
| **1.5** | Phase 1: Origin | Raw File Download (`GET /origin/file/:id/raw`) | `200 OK` with correct binary payload | `PASS` |
| **1.6** | Phase 1: Origin | Non-existent File ID Query | `404 Not Found` | `PASS` |
| **1.7** | Phase 1: Redis | Edge Node Registration & Tracking | Adds edge ID to Redis set | `PASS` |
| **1.8** | Phase 1: Redis | Fallback State Persistence (`shared/.redis_state.json`)| JSON fallback written on connection loss | `PASS` |
| **1.9** | Phase 1: PostgreSQL | Schema Migration Verification (`init.sql`) | Tables `files`, `edges`, `request_logs` created | `PASS` |
| **1.10** | Phase 1: PostgreSQL | Edge Metadata Sync | Edge IP/port rows inserted correctly | `PASS` |
| **1.11** | Phase 1: Security | Unauthorized Token Signing Attempt | `403 Forbidden` | `PASS` |
| **1.12** | Phase 1: Upload | Large File Payload Buffer Test | Binary file saved cleanly to storage | `PASS` |
| **1.13** | Phase 1: Health | Origin Service Health Endpoint (`GET /health`) | `200 OK` `{ status: "ok" }` | `PASS` |
| **2.1** | Phase 2: Edge | Cold Cache Miss Proxying (`GET /edge/file/:id`) | Header `X-Cache-Status: MISS` | `PASS` |
| **2.2** | Phase 2: Edge | Warm Cache Hit Serving (`GET /edge/file/:id`) | Header `X-Cache-Status: HIT` | `PASS` |
| **2.3** | Phase 2: Edge | Cache File Disk Storage Verification | File saved in `edge/cache/edge_N/` | `PASS` |
| **2.4** | Phase 2: Edge | Cache Recency Timestamp Update | Timestamp logged in Redis `edge:N:cache` | `PASS` |
| **2.5** | Phase 2: Edge | LRU Cache Eviction on Capacity Exceeded | Oldest file deleted from disk | `PASS` |
| **2.6** | Phase 2: Edge | Heartbeat Dispatch (`POST /lb/heartbeat`) | Heartbeat acknowledged by Load Balancer | `PASS` |
| **2.7** | Phase 2: Edge | Proactive Push Receiver (`POST /edge/receive`) | Header `X-File-Id` acknowledged & stored | `PASS` |
| **2.8** | Phase 2: Edge | Download Counter Increment | Counter updated in Redis | `PASS` |
| **2.9** | Phase 2: Edge | Concurrent Download Request Deduplication | Single origin fetch for parallel requests | `PASS` |
| **2.10** | Phase 2: Edge | Partial Cache File Unlinking on Stream Error | `.tmp` file deleted cleanly on failure | `PASS` |
| **2.11** | Phase 2: Edge | Non-existent File Forwarding | Returns `404` from Origin | `PASS` |
| **2.12** | Phase 2: Edge | Edge Health Status Query | `200 OK` `{ status: "ok", edgeId: N }` | `PASS` |
| **3.1** | Phase 3: LB | Round-Robin Load Balancing Routing | Requests alternate `Edge 1 → 2 → 3` | `PASS` |
| **3.2** | Phase 3: LB | LB Metric Headers Injection | Headers `X-Routed-Edge-Id`, `X-LB-Latency` | `PASS` |
| **3.3** | Phase 3: LB | Health Monitor Offline Marking (>25s) | Node status marked `offline` in DB/Redis | `PASS` |
| **3.4** | Phase 3: LB | Automatic Retry Failover | Reroutes to healthy edge if primary fails | `PASS` |
| **3.5** | Phase 3: LB | Aggregated System Telemetry (`GET /lb/stats`) | Returns `totalHits`, `totalMisses`, `hitRatio` | `PASS` |
| **3.6** | Phase 3: LB | Telemetry Graph Reset (`POST /lb/reset`) | Wipes hit/miss counters & state files to 0 | `PASS` |
| **3.7** | Phase 3: LB | Origin Popularity Worker Sync | Pushes file bytes when downloads $\ge 20$ | `PASS` |
| **3.8** | Phase 3: LB | Database Request Logging | Inserts row in `request_logs` table | `PASS` |
| **3.9** | Phase 3: LB | All Nodes Offline Graceful Handling | Returns `503 Service Unavailable` | `PASS` |
| **3.10** | Phase 3: LB | Static Dashboard Serving (`GET /dashboard`) | Returns `index.html` static dashboard | `PASS` |

---

## 📊 Telemetry & Graph Interpretation Guide

### 1. Grouped Bar Chart (Chart.js):
- **Green Bar (Hits)**: Number of requests served directly from the Edge node's local disk cache without contacting Origin.
- **Red Bar (Misses)**: Number of requests where the Edge node did not have the file and had to stream it from Origin.

### 2. Overall Hit Ratio Formula:
$$\text{Overall Hit Ratio} = \frac{\text{Total Edge Hits}}{\text{Total Edge Hits} + \text{Total Edge Misses}}$$
- **Ideal Production Target**: $> 85.0\%$ (Represented by tall Green Bars).
- **Cold Start Target**: $0.0\%$ (Represented by Red Bars).

### 3. Node Health Dots:
- **Green Glowing Dot (`healthy`)**: Edge server is active and sending heartbeats every 10s.
- **Red Dot (`offline`)**: Edge server missed heartbeats (>25s) or container stopped. Automatically excluded from routing pool.
