const express = require('express');
const fs = require('fs');
const path = require('path');
const logger = require('../../shared/logger');
const redis = require('../../shared/redis');

const router = express.Router();

function getEdgeStatsData(targetEdgeId) {
  const edgeId = parseInt(targetEdgeId, 10);
  const cacheDir = path.join(__dirname, `../cache/edge_${edgeId}`);

  let cacheSizeFiles = 0;
  let cacheSizeBytes = 0;
  const cachedFileIds = [];

  if (fs.existsSync(cacheDir)) {
    const files = fs.readdirSync(cacheDir);
    for (const file of files) {
      if (file.endsWith('.tmp')) continue; // Skip temporary write buffers
      const filePath = path.join(cacheDir, file);
      try {
        const stats = fs.statSync(filePath);
        if (stats.isFile()) {
          cacheSizeFiles++;
          cacheSizeBytes += stats.size;
          cachedFileIds.push(file);
        }
      } catch (err) {
        // Handle race condition if file was deleted during scan
      }
    }
  }

  return { edgeId, cacheDir, cacheSizeFiles, cacheSizeBytes, cachedFileIds };
}

// GET /edge/stats — Stats for current edge server instance
router.get('/stats', async (req, res) => {
  const currentEdgeId = parseInt(process.env.EDGE_ID || '1', 10);
  try {
    const { hits, misses } = await redis.getEdgeHitMissStats(currentEdgeId);
    const diskStats = getEdgeStatsData(currentEdgeId);

    return res.json({
      edgeId: currentEdgeId,
      hits,
      misses,
      totalRequests: hits + misses,
      cacheSizeFiles: diskStats.cacheSizeFiles,
      cacheSizeBytes: diskStats.cacheSizeBytes,
      cachedFileIds: diskStats.cachedFileIds
    });
  } catch (err) {
    logger.error({ err }, 'Error retrieving edge stats');
    return res.status(500).json({ error: 'Failed to retrieve stats' });
  }
});

// GET /edge/:id/stats — Stats for a specific edge server ID
router.get('/:id/stats', async (req, res) => {
  const targetEdgeId = parseInt(req.params.id, 10);
  if (isNaN(targetEdgeId)) {
    return res.status(400).json({ error: 'Invalid edge ID' });
  }

  try {
    const { hits, misses } = await redis.getEdgeHitMissStats(targetEdgeId);
    const diskStats = getEdgeStatsData(targetEdgeId);

    return res.json({
      edgeId: targetEdgeId,
      hits,
      misses,
      totalRequests: hits + misses,
      cacheSizeFiles: diskStats.cacheSizeFiles,
      cacheSizeBytes: diskStats.cacheSizeBytes,
      cachedFileIds: diskStats.cachedFileIds
    });
  } catch (err) {
    logger.error({ err, targetEdgeId }, 'Error retrieving specific edge stats');
    return res.status(500).json({ error: 'Failed to retrieve stats' });
  }
});

// POST /edge/purge — Purge disk cache files and LRU state for this edge server
router.post('/purge', async (req, res) => {
  const currentEdgeId = parseInt(process.env.EDGE_ID || '1', 10);
  const cacheDir = path.join(__dirname, `../cache/edge_${currentEdgeId}`);
  if (fs.existsSync(cacheDir)) {
    try {
      const files = fs.readdirSync(cacheDir);
      for (const f of files) {
        if (f !== '.gitkeep') {
          try { fs.unlinkSync(path.join(cacheDir, f)); } catch (e) {}
        }
      }
    } catch (e) {}
  }
  try {
    const lru = require('../lru');
    if (lru && typeof lru.clear === 'function') lru.clear();
  } catch (e) {}

  try {
    if (redis && typeof redis.resetTelemetryStats === 'function') {
      await redis.resetTelemetryStats(true);
    }
  } catch (e) {}

  logger.info({ edgeId: currentEdgeId }, 'Edge node disk cache, LRU state, and telemetry metrics purged via LB command');
  return res.json({ success: true, message: `Edge ${currentEdgeId} cache purged successfully` });
});

module.exports = router;
