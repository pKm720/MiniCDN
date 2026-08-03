const Redis = require('ioredis');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const logger = require('./logger');

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const STATE_FILE = path.join(__dirname, '.redis_state.json');

/**
 * ARCHITECTURAL DESIGN NOTE / KNOWN LIMITATION:
 * Once `useFallback = true` is tripped by Redis unreachability, key operations degrade to the local
 * IPC state file (.redis_state.json) for process lifetime stability to maintain write consistency.
 * Production enhancement: Implement a lazy reconnection strategy with a probing background timer
 * that flushes offline key deltas back to Redis upon recovery.
 */
let useFallback = false;

let inMemoryState = null;
let saveTimer = null;

function loadState() {
  if (inMemoryState) return inMemoryState;
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      inMemoryState = JSON.parse(data);
      if (!inMemoryState.sets) inMemoryState.sets = {};
      if (!inMemoryState.hashes) inMemoryState.hashes = {};
      if (!inMemoryState.kv) inMemoryState.kv = {};
      return inMemoryState;
    }
  } catch (e) {}
  inMemoryState = { sets: {}, hashes: {}, kv: {} };
  return inMemoryState;
}

function saveState(newState) {
  const currentState = loadState();
  if (newState.sets) {
    for (const sKey of Object.keys(newState.sets)) {
      currentState.sets[sKey] = Array.from(new Set([...(currentState.sets[sKey] || []), ...newState.sets[sKey]]));
    }
  }
  if (newState.hashes) {
    for (const hKey of Object.keys(newState.hashes)) {
      currentState.hashes[hKey] = { ...(currentState.hashes[hKey] || {}), ...newState.hashes[hKey] };
    }
  }
  if (newState.kv) Object.assign(currentState.kv, newState.kv);

  if (!saveTimer) {
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(inMemoryState, null, 2), 'utf8');
      } catch (e) {}
    }, 100);
  }
}

const redisClient = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  connectTimeout: 200,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  lazyConnect: true,
  retryStrategy(times) {
    if (times > 1) {
      if (!useFallback) {
        useFallback = true;
      }
      return null;
    }
    return 200;
  }
});

redisClient.on('error', () => {
  useFallback = true;
});

async function initRedis() {
  try {
    await redisClient.connect();
    logger.info(`Connected to Redis server at ${REDIS_HOST}:${REDIS_PORT}`);
  } catch (err) {
    useFallback = true;
    logger.info('Redis server offline. Operating with multi-process IPC memory fallback.');
  }
}

// -------------------------------------------------------------------
// Key 1: file:{id}:edges -> SET of edge_ids currently caching file
// -------------------------------------------------------------------
async function addFileToEdge(fileId, edgeId) {
  const key = `file:${fileId}:edges`;
  const val = String(edgeId);

  if (!useFallback) {
    try {
      await redisClient.sadd(key, val);
      return;
    } catch (err) {
      useFallback = true;
    }
  }

  const state = loadState();
  if (!state.sets[key]) state.sets[key] = [];
  if (!state.sets[key].includes(val)) {
    state.sets[key].push(val);
  }
  saveState(state);
}

async function removeFileFromEdge(fileId, edgeId) {
  const key = `file:${fileId}:edges`;
  const val = String(edgeId);

  if (!useFallback) {
    try {
      await redisClient.srem(key, val);
      return;
    } catch (err) {
      useFallback = true;
    }
  }

  const state = loadState();
  if (state.sets[key]) {
    state.sets[key] = state.sets[key].filter(e => e !== val);
    saveState(state);
  }
}

async function getEdgesForFile(fileId) {
  const key = `file:${fileId}:edges`;

  if (!useFallback) {
    try {
      const members = await redisClient.smembers(key);
      return members;
    } catch (err) {
      useFallback = true;
    }
  }

  const state = loadState();
  return state.sets[key] || [];
}

// -------------------------------------------------------------------
// Key 2: edge:{id}:cache -> HASH mapping fileId -> lastAccessedTimestamp
// -------------------------------------------------------------------
async function updateEdgeRecency(edgeId, fileId, timestamp = Date.now()) {
  const key = `edge:${edgeId}:cache`;
  const fId = String(fileId);
  const ts = String(timestamp);

  if (!useFallback) {
    try {
      await redisClient.hset(key, fId, ts);
      return;
    } catch (err) {
      useFallback = true;
    }
  }

  const state = loadState();
  if (!state.hashes[key]) state.hashes[key] = {};
  state.hashes[key][fId] = ts;
  saveState(state);
}

async function removeEdgeRecency(edgeId, fileId) {
  const key = `edge:${edgeId}:cache`;
  const fId = String(fileId);

  if (!useFallback) {
    try {
      await redisClient.hdel(key, fId);
      return;
    } catch (err) {
      useFallback = true;
    }
  }

  const state = loadState();
  if (state.hashes[key]) {
    delete state.hashes[key][fId];
    saveState(state);
  }
}

async function getEdgeCacheRecency(edgeId) {
  const key = `edge:${edgeId}:cache`;

  if (!useFallback) {
    try {
      const data = await redisClient.hgetall(key);
      return data || {};
    } catch (err) {
      useFallback = true;
    }
  }

  const state = loadState();
  return state.hashes[key] || {};
}

// -------------------------------------------------------------------
// Key 3: edge:{id}:heartbeat -> string timestamp of last heartbeat
// -------------------------------------------------------------------
async function setHeartbeat(edgeId, timestamp = Date.now()) {
  const key = `edge:${edgeId}:heartbeat`;
  const ts = String(timestamp);

  if (!useFallback) {
    try {
      await redisClient.set(key, ts);
      return;
    } catch (err) {
      useFallback = true;
    }
  }

  const state = loadState();
  state.kv[key] = ts;
  saveState(state);
}

async function getHeartbeat(edgeId) {
  const key = `edge:${edgeId}:heartbeat`;

  if (!useFallback) {
    try {
      const val = await redisClient.get(key);
      return val;
    } catch (err) {
      useFallback = true;
    }
  }

  const state = loadState();
  return state.kv[key] || null;
}

// -------------------------------------------------------------------
// Key 4: edge:{id}:ttl -> HASH mapping fileId -> cachedAt timestamp
// -------------------------------------------------------------------
async function setCacheTtl(edgeId, fileId, timestamp = Date.now()) {
  const key = `edge:${edgeId}:ttl`;
  const fId = String(fileId);
  const ts = String(timestamp);

  if (!useFallback) {
    try {
      await redisClient.hset(key, fId, ts);
      return;
    } catch (err) {
      useFallback = true;
    }
  }

  const state = loadState();
  if (!state.hashes[key]) state.hashes[key] = {};
  state.hashes[key][fId] = ts;
  saveState(state);
}

async function getCacheTtl(edgeId, fileId) {
  const key = `edge:${edgeId}:ttl`;
  const fId = String(fileId);

  if (!useFallback) {
    try {
      const val = await redisClient.hget(key, fId);
      return val ? parseInt(val, 10) : null;
    } catch (err) {
      useFallback = true;
    }
  }

  const state = loadState();
  const val = state.hashes[key] ? state.hashes[key][fId] : null;
  return val ? parseInt(val, 10) : null;
}

async function removeCacheTtl(edgeId, fileId) {
  const key = `edge:${edgeId}:ttl`;
  const fId = String(fileId);

  if (!useFallback) {
    try {
      await redisClient.hdel(key, fId);
      return;
    } catch (err) {
      useFallback = true;
    }
  }

  const state = loadState();
  if (state.hashes[key]) {
    delete state.hashes[key][fId];
    saveState(state);
  }
}

// -------------------------------------------------------------------
// Key 5: file:{id}:downloads -> INT counter for file downloads
// -------------------------------------------------------------------
async function incrementDownloadCount(fileId) {
  const key = `file:${fileId}:downloads`;
  const fId = String(fileId);

  if (!useFallback) {
    try {
      const newCount = await redisClient.incr(key);
      return newCount;
    } catch (err) {
      useFallback = true;
    }
  }

  const state = loadState();
  if (!state.kv[key]) state.kv[key] = "0";
  const newCount = parseInt(state.kv[key], 10) + 1;
  state.kv[key] = String(newCount);
  saveState(state);
  return newCount;
}

async function getDownloadCount(fileId) {
  const key = `file:${fileId}:downloads`;

  if (!useFallback) {
    try {
      const val = await redisClient.get(key);
      return val ? parseInt(val, 10) : 0;
    } catch (err) {
      useFallback = true;
    }
  }

  const state = loadState();
  return state.kv[key] ? parseInt(state.kv[key], 10) : 0;
}

async function getAllDownloadCounts() {
  const result = {};

  if (!useFallback) {
    try {
      const keys = await redisClient.keys('file:*:downloads');
      for (const key of keys) {
        const parts = key.split(':');
        const fileId = parts[1];
        const val = await redisClient.get(key);
        if (fileId && val) {
          result[fileId] = parseInt(val, 10);
        }
      }
      return result;
    } catch (err) {
      useFallback = true;
    }
  }

  const state = loadState();
  for (const key of Object.keys(state.kv)) {
    if (key.startsWith('file:') && key.endsWith(':downloads')) {
      const parts = key.split(':');
      const fileId = parts[1];
      const val = state.kv[key];
      if (fileId && val) {
        result[fileId] = parseInt(val, 10);
      }
    }
  }
  return result;
}

// -------------------------------------------------------------------
// Key 6: file:{id}:replicated -> String timestamp of replication
// -------------------------------------------------------------------
async function setReplicatedFlag(fileId, timestamp = Date.now()) {
  const key = `file:${fileId}:replicated`;
  const val = String(timestamp);

  if (!useFallback) {
    try {
      await redisClient.set(key, val);
      return;
    } catch (err) {
      useFallback = true;
    }
  }

  const state = loadState();
  state.kv[key] = val;
  saveState(state);
}

async function getReplicatedFlag(fileId) {
  const key = `file:${fileId}:replicated`;

  if (!useFallback) {
    try {
      const val = await redisClient.get(key);
      return val ? parseInt(val, 10) : null;
    } catch (err) {
      useFallback = true;
    }
  }

  const state = loadState();
  return state.kv[key] ? parseInt(state.kv[key], 10) : null;
}

// -------------------------------------------------------------------
// Key 7: edge:{id}:hits and edge:{id}:misses counters
// -------------------------------------------------------------------
async function incrementEdgeHit(edgeId) {
  const key = `edge:${edgeId}:hits`;

  if (!useFallback) {
    try {
      const val = await redisClient.incr(key);
      return val;
    } catch (err) {
      useFallback = true;
    }
  }

  const state = loadState();
  if (!state.kv[key]) state.kv[key] = "0";
  const val = parseInt(state.kv[key], 10) + 1;
  state.kv[key] = String(val);
  saveState(state);
  return val;
}

async function incrementEdgeMiss(edgeId) {
  const key = `edge:${edgeId}:misses`;

  if (!useFallback) {
    try {
      const val = await redisClient.incr(key);
      return val;
    } catch (err) {
      useFallback = true;
    }
  }

  const state = loadState();
  if (!state.kv[key]) state.kv[key] = "0";
  const val = parseInt(state.kv[key], 10) + 1;
  state.kv[key] = String(val);
  saveState(state);
  return val;
}

async function getEdgeHitMissStats(edgeId) {
  const hitKey = `edge:${edgeId}:hits`;
  const missKey = `edge:${edgeId}:misses`;

  if (!useFallback) {
    try {
      const hitsVal = await redisClient.get(hitKey);
      const missesVal = await redisClient.get(missKey);
      return {
        hits: hitsVal ? parseInt(hitsVal, 10) : 0,
        misses: missesVal ? parseInt(missesVal, 10) : 0
      };
    } catch (err) {
      useFallback = true;
    }
  }

  const state = loadState();
  const hitsVal = state.kv[hitKey] ? parseInt(state.kv[hitKey], 10) : 0;
  const missesVal = state.kv[missKey] ? parseInt(state.kv[missKey], 10) : 0;
  return { hits: hitsVal, misses: missesVal };
}

async function resetTelemetryStats() {
  if (!useFallback && redisClient && redisClient.status === 'ready') {
    try {
      for (let id = 1; id <= 3; id++) {
        await redisClient.set(`edge:${id}:hits`, 0).catch(() => {});
        await redisClient.set(`edge:${id}:misses`, 0).catch(() => {});
      }
    } catch (e) {}
  }

  try {
    if (fs.existsSync(STATE_FILE)) {
      fs.writeFileSync(STATE_FILE, JSON.stringify({ sets: {}, hashes: {}, kv: {} }), 'utf8');
    }
  } catch (e) {}
}

module.exports = {
  redisClient,
  initRedis,
  addFileToEdge,
  removeFileFromEdge,
  getEdgesForFile,
  updateEdgeRecency,
  removeEdgeRecency,
  getEdgeCacheRecency,
  setHeartbeat,
  getHeartbeat,
  setCacheTtl,
  getCacheTtl,
  removeCacheTtl,
  incrementDownloadCount,
  getDownloadCount,
  getAllDownloadCounts,
  setReplicatedFlag,
  getReplicatedFlag,
  incrementEdgeHit,
  incrementEdgeMiss,
  getEdgeHitMissStats,
  resetTelemetryStats
};
