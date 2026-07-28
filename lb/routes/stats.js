const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../../shared/db');
const redis = require('../../shared/redis');
const logger = require('../../shared/logger');

const router = express.Router();

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
      const status = edge.status || 'healthy';
      if (status === 'healthy') healthyEdgesCount++;

      const { hits, misses } = await redis.getEdgeHitMissStats(edgeId);
      const diskStats = getDiskStatsForEdge(edgeId);
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
        cacheSizeFiles: diskStats.cacheSizeFiles,
        cacheSizeBytes: diskStats.cacheSizeBytes,
        cachedFileIds: diskStats.cachedFileIds
      });
    }

    const totalRequests = totalHits + totalMisses;
    const overallHitRatio = totalRequests > 0 ? Number((totalHits / totalRequests).toFixed(4)) : 0.0;

    return res.json({
      totalHits,
      totalMisses,
      totalRequests,
      overallHitRatio,
      healthyEdgesCount,
      totalEdgesCount: edgesBreakdown.length,
      edges: edgesBreakdown
    });
  } catch (err) {
    logger.error({ err }, 'Error building aggregated LB stats');
    return res.status(500).json({ error: 'Failed to aggregate LB stats' });
  }
});

module.exports = router;
