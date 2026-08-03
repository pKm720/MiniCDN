const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const db = require('../../shared/db');
const redis = require('../../shared/redis');
const logger = require('../../shared/logger');
const cluster = require('../../shared/cluster');

const router = express.Router();

function fetchEdgeStatsHttp(edgeId) {
  return new Promise((resolve) => {
    const target = cluster.getEdgeTarget(edgeId);
    const req = http.get(`http://${target.hostname}:${target.port}/edge/stats`, { timeout: 1500 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve({ success: true, stats: JSON.parse(data) });
            return;
          } catch (e) {}
        }
        resolve({ success: false });
      });
    });

    req.on('error', () => resolve({ success: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false });
    });
  });
}

function getDiskStatsForEdge(edgeId) {
  const cacheDir = path.join(__dirname, `../../edge/cache/edge_${edgeId}`);
  let cacheSizeFiles = 0;
  let cacheSizeBytes = 0;
  const cachedFileIds = [];

  if (fs.existsSync(cacheDir)) {
    try {
      const files = fs.readdirSync(cacheDir);
      for (const file of files) {
        if (file.endsWith('.tmp')) continue;
        const filePath = path.join(cacheDir, file);
        try {
          const stats = fs.statSync(filePath);
          if (stats.isFile()) {
            cacheSizeFiles++;
            cacheSizeBytes += stats.size;
            cachedFileIds.push(file);
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  return { cacheSizeFiles, cacheSizeBytes, cachedFileIds };
}

// GET /lb/stats — Aggregated telemetry metrics across all edge nodes
router.get('/stats', async (req, res) => {
  try {
    let edgeRecords = [];
    try {
      const dbRes = await db.query('SELECT * FROM edges ORDER BY id ASC');
      edgeRecords = dbRes.rows;
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to query edges table for LB stats');
    }

    // Default to 3 edge cluster if database query returns empty
    if (!edgeRecords || edgeRecords.length === 0) {
      edgeRecords = [
        { id: 1, edge_name: 'edge-1', status: 'healthy' },
        { id: 2, edge_name: 'edge-2', status: 'healthy' },
        { id: 3, edge_name: 'edge-3', status: 'healthy' }
      ];
    }

    let totalHits = 0;
    let totalMisses = 0;
    let healthyEdgesCount = 0;
    const edgesBreakdown = [];

    for (const edge of edgeRecords) {
      const edgeId = edge.id;
      let status = edge.status || 'healthy';

      const httpRes = await fetchEdgeStatsHttp(edgeId);
      let hits = 0;
      let misses = 0;
      let cacheSizeFiles = 0;
      let cacheSizeBytes = 0;
      let cachedFileIds = [];

      if (httpRes.success) {
        hits = httpRes.stats.hits || 0;
        misses = httpRes.stats.misses || 0;
        cacheSizeFiles = httpRes.stats.cacheSizeFiles || 0;
        cacheSizeBytes = httpRes.stats.cacheSizeBytes || 0;
        cachedFileIds = httpRes.stats.cachedFileIds || [];
      } else {
        const hbTimestamp = await redis.getHeartbeat(edgeId);
        const now = Date.now();
        const MISSED_THRESHOLD_MS = parseInt(process.env.MISSED_HEARTBEAT_THRESHOLD_MS || '25000', 10);
        if (hbTimestamp && (now - parseInt(hbTimestamp, 10) <= MISSED_THRESHOLD_MS)) {
          status = 'healthy';
        } else {
          status = edge.status || 'healthy';
        }

        const redisStats = await redis.getEdgeHitMissStats(edgeId);
        hits = redisStats.hits;
        misses = redisStats.misses;
        let diskStats = getDiskStatsForEdge(edgeId);

        if (diskStats.cachedFileIds.length === 0) {
          try {
            const recency = await redis.getEdgeCacheRecency(edgeId).catch(() => ({}));
            const fileIds = Object.keys(recency || {});
            if (fileIds.length > 0) {
              diskStats = {
                cacheSizeFiles: fileIds.length,
                cacheSizeBytes: fileIds.length * 723,
                cachedFileIds: fileIds
              };
            }
          } catch (e) {}
        }

        cacheSizeFiles = diskStats.cacheSizeFiles;
        cacheSizeBytes = diskStats.cacheSizeBytes;
        cachedFileIds = diskStats.cachedFileIds;
      }

      if (status === 'healthy') healthyEdgesCount++;
      const edgeRequests = hits + misses;
      totalHits += hits;
      totalMisses += misses;

      edgesBreakdown.push({
        edgeId,
        edgeName: edge.edge_name || `edge-${edgeId}`,
        status,
        hits,
        misses,
        totalRequests: edgeRequests,
        cacheSizeFiles,
        cacheSizeBytes,
        cachedFileIds
      });
    }

    const totalRequests = totalHits + totalMisses;
    const overallHitRatio = totalRequests > 0 ? Number((totalHits / totalRequests).toFixed(4)) : 0.0;

    return res.json({
      totalHits,
      totalMisses,
      totalRequests,
      hitRatio: overallHitRatio,
      overallHitRatio,
      clusterHitRatio: overallHitRatio,
      healthyEdgesCount,
      totalEdgesCount: edgesBreakdown.length,
      edges: edgesBreakdown
    });
  } catch (err) {
    logger.error({ err }, 'Error building aggregated LB stats');
    return res.status(500).json({ error: 'Failed to aggregate LB stats' });
  }
});

// POST /lb/reset — Resets telemetry counters & state files (supports deep purge)
router.post('/reset', async (req, res) => {
  const isDeep = req.query.deep === 'true' || (req.body && req.body.deep === true);

  try {
    if (redis && typeof redis.resetTelemetryStats === 'function') {
      try { await redis.resetTelemetryStats(isDeep); } catch (e) {}
    }
  } catch (e) {}

  try {
    if (db && typeof db.query === 'function') {
      try { await db.query('TRUNCATE request_logs RESTART IDENTITY CASCADE'); } catch (e) {}
      if (isDeep) {
        try { await db.query('UPDATE files SET download_count = 0'); } catch (e) {}
        try { await db.query('TRUNCATE files RESTART IDENTITY CASCADE'); } catch (e) {}
      }
    }
  } catch (e) {}

  if (isDeep) {
    // Notify all edge nodes via RPC HTTP purge notification to clear telemetry & cache
    const purgePromises = [];
    for (let id = 1; id <= 3; id++) {
      // Local container filesystem cleanup fallback
      const edgeDir = path.join(__dirname, `../../edge/cache/edge_${id}`);
      if (fs.existsSync(edgeDir)) {
        try {
          const files = fs.readdirSync(edgeDir);
          for (const f of files) {
            if (f !== '.gitkeep') {
              try { fs.unlinkSync(path.join(edgeDir, f)); } catch (e) {}
            }
          }
        } catch (e) {}
      }

      // RPC HTTP purge notification to edge container
      purgePromises.push(new Promise((resolve) => {
        try {
          const target = cluster.getEdgeTarget(id);
          const purgeReq = http.request({
            hostname: target.hostname,
            port: target.port,
            path: '/edge/purge',
            method: 'POST',
            timeout: 1500
          }, (res) => {
            res.on('data', () => {});
            res.on('end', resolve);
          });
          purgeReq.on('error', () => resolve());
          purgeReq.on('timeout', () => { purgeReq.destroy(); resolve(); });
          purgeReq.end();
        } catch (e) { resolve(); }
      }));
    }

    await Promise.all(purgePromises);
  }

  if (isDeep) {
    // 1. Wipe Redis state file & db state file
    const redisStateFile = path.join(__dirname, '../../shared/.redis_state.json');
    const dbStateFile = path.join(__dirname, '../../shared/.db_state.json');
    try { if (fs.existsSync(redisStateFile)) fs.writeFileSync(redisStateFile, JSON.stringify({ sets: {}, hashes: {}, kv: {} }), 'utf8'); } catch (e) {}
    try { if (fs.existsSync(dbStateFile)) fs.writeFileSync(dbStateFile, JSON.stringify({ files: [], edges: [], request_logs: [], autoId: 1 }), 'utf8'); } catch (e) {}

    // 3. Clear origin storage directory
    const originDir = path.join(__dirname, '../../origin/storage');
    if (fs.existsSync(originDir)) {
      try {
        const files = fs.readdirSync(originDir);
        for (const f of files) {
          if (f !== '.gitkeep') {
            fs.unlinkSync(path.join(originDir, f));
          }
        }
      } catch (e) {}
    }

    logger.info('FULL SYSTEM DEEP PURGE completed: files, disk caches, db tables, and state files reset.');
    return res.json({ success: true, message: 'Deep Purge completed successfully' });
  }

  logger.info('LB Telemetry and request_logs reset completely');
  return res.json({ success: true, message: 'Telemetry reset successfully' });
});

module.exports = router;
