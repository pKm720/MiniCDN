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

module.exports = router;
