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
 * When Redis is unreachable, `useFallback = true` switches to local IPC state file (.redis_state.json).
 * A background check periodically attempts to ping Redis every 15s.
 * Once Redis recovers (2 consecutive successful pings), the system automatically resumes using Redis.
 * Note: Data written during the fallback window is not retroactively replayed on recovery.
 */
let useFallback = false;

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(data);
      if (!parsed.sets) parsed.sets = {};
      if (!parsed.hashes) parsed.hashes = {};
      if (!parsed.kv) parsed.kv = {};
      return parsed;
    }
  } catch (e) {}
  return { sets: {}, hashes: {}, kv: {} };
}

function saveState(newState) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(newState, null, 2), 'utf8');
  } catch (e) {}
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

let consecutiveRedisPings = 0;
setInterval(async () => {
  if (useFallback) {
    try {
      if (redisClient.status === 'end' || redisClient.status === 'close') {
        await redisClient.connect().catch(() => {});
      }
      const res = await redisClient.ping();
      if (res === 'PONG') {
        consecutiveRedisPings++;
        if (consecutiveRedisPings >= 2) {
          useFallback = false;
          consecutiveRedisPings = 0;
          logger.info('Redis connection recovered. Switching from fallback to Redis (Note: fallback-window writes are not retroactively replayed).');
        }
      }
    } catch (e) {
      consecutiveRedisPings = 0;
    }
  } else {
    consecutiveRedisPings = 0;
  }
}, 15000).unref();

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

async function resetTelemetryStats(isDeep = false) {
  if (redisClient) {
    try {
      for (let id = 1; id <= 3; id++) {
        await redisClient.set(`edge:${id}:hits`, 0).catch(() => {});
        await redisClient.set(`edge:${id}:misses`, 0).catch(() => {});
        if (isDeep) {
          await redisClient.del(`edge:${id}:cache`).catch(() => {});
          await redisClient.del(`edge:${id}:ttl`).catch(() => {});
        }
      }
      if (isDeep) {
        const dlKeys = await redisClient.keys('file:*').catch(() => []);
        if (dlKeys && dlKeys.length > 0) {
          await redisClient.del(dlKeys).catch(() => {});
        }
      }
    } catch (e) {}
  }

  if (isDeep) {
    saveState({ sets: {}, hashes: {}, kv: {} });
  } else {
    const state = loadState();
    for (let id = 1; id <= 3; id++) {
      state.kv[`edge:${id}:hits`] = "0";
      state.kv[`edge:${id}:misses`] = "0";
    }
    saveState(state);
  }
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
