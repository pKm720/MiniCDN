const express = require('express');
const router = express.Router();
const http = require('http');
const db = require('../../shared/db');
const logger = require('../../shared/logger');
const cluster = require('../../shared/cluster');

let roundRobinIndex = 0;

function forwardToEdge(edgeId, fileId, req, res) {
  return new Promise((resolve, reject) => {
    // Fast fail for standalone cloud single-container deployments
    const isStandaloneCloud = Boolean(process.env.PORT || process.env.RAILWAY_STATIC_URL || process.env.RENDER);
    if (isStandaloneCloud && !process.env.HAS_EDGE_CONTAINERS) {
      return reject(new Error('Standalone Cloud Fallback Triggered'));
    }

    const startTime = Date.now();
    const target = cluster.getEdgeTarget(edgeId);

    const reqOptions = {
      hostname: target.hostname,
      port: target.port,
      path: `/edge/file/${fileId}`,
      method: 'GET',
      headers: { 'X-Target-Edge-Id': String(edgeId) },
      timeout: 3000
    };

    const edgeReq = http.request(reqOptions, (edgeRes) => {
      const latencyMs = Date.now() - startTime;
      const cacheStatus = edgeRes.headers['x-cache-status'] || 'MISS';
      const isHit = cacheStatus === 'HIT';

      // Log routed request to database
      db.query(
        'INSERT INTO request_logs (file_id, edge_id, hit, latency_ms) VALUES ($1, $2, $3, $4)',
        [parseInt(fileId, 10), parseInt(edgeId, 10), isHit, latencyMs]
      ).catch(err => logger.error({ err }, 'Failed to insert request log'));

      // Proxy response headers
      res.statusCode = edgeRes.statusCode;
      if (edgeRes.headers['content-type']) res.setHeader('Content-Type', edgeRes.headers['content-type']);
      if (edgeRes.headers['content-length']) res.setHeader('Content-Length', edgeRes.headers['content-length']);
      res.setHeader('X-Cache-Status', cacheStatus);
      res.setHeader('X-Routed-Edge-Id', edgeId);
      res.setHeader('X-LB-Latency-Ms', latencyMs);
      res.setHeader('Access-Control-Expose-Headers', 'X-Routed-Edge-Id, X-Cache-Status, X-LB-Latency-Ms');

      edgeRes.pipe(res);
      resolve({ success: true, statusCode: edgeRes.statusCode, edgeId, isHit, latencyMs });
    });

    edgeReq.on('error', (err) => {
      reject(err);
    });

    edgeReq.setTimeout(300, () => {
      edgeReq.destroy();
      reject(new Error(`Timeout forwarding request to Edge ${edgeId}`));
    });

    edgeReq.end();
  });
}

router.get('/file/:id', async (req, res) => {
  const fileId = req.params.id;

  try {
    // 1. Fetch currently healthy edges from database
    const dbResult = await db.query("SELECT * FROM edges WHERE status = 'healthy' ORDER BY id ASC").catch(() => null);
    let healthyEdges = (dbResult && dbResult.rows && dbResult.rows.length > 0) ? dbResult.rows : [
      { id: 1, name: 'edge-1', status: 'healthy' },
      { id: 2, name: 'edge-2', status: 'healthy' },
      { id: 3, name: 'edge-3', status: 'healthy' }
    ];

    // 2. Select edge using Round-Robin strategy (or sticky edge query/header override for benchmark validation)
    const edgeOverride = req.query.edgeId || req.headers['x-force-edge-id'];
    const forcedEdgeId = edgeOverride ? parseInt(edgeOverride, 10) : null;
    let primaryEdgeId = forcedEdgeId;

    if (!primaryEdgeId) {
      const chosenIndex = roundRobinIndex % healthyEdges.length;
      roundRobinIndex = (roundRobinIndex + 1) % 1000000; // prevent overflow
      const primaryEdge = healthyEdges[chosenIndex];
      primaryEdgeId = primaryEdge.id;
    }

    logger.info({ fileId, chosenEdgeId: primaryEdgeId, healthyCount: healthyEdges.length }, 'Routing request via LB round-robin');

    // 3. Attempt forward to primary chosen edge
    try {
      await forwardToEdge(primaryEdgeId, fileId, req, res);
    } catch (primaryErr) {
      logger.warn({ primaryEdgeId, err: primaryErr.message, fileId }, 'Primary chosen edge unreachable. Processing cloud fallback...');

      // Handle standalone single-container cloud fallback (e.g. Railway/Render free tier)
      try {
        const recency = await redis.getEdgeCacheRecency(primaryEdgeId).catch(() => ({}));
        const isHit = recency && recency[String(fileId)];

        if (isHit) {
          await redis.incrementEdgeHit(primaryEdgeId).catch(() => {});
          res.setHeader('X-Cache-Status', 'HIT');
        } else {
          await redis.incrementEdgeMiss(primaryEdgeId).catch(() => {});
          await redis.updateEdgeRecency(primaryEdgeId, fileId, Date.now()).catch(() => {});
          await redis.addFileToEdge(fileId, primaryEdgeId).catch(() => {});
          await redis.incrementDownloadCount(fileId).catch(() => {});
          res.setHeader('X-Cache-Status', 'MISS');
        }

        res.setHeader('X-Routed-Edge-Id', primaryEdgeId);
        res.setHeader('Content-Type', 'text/plain');
        if (!res.headersSent) {
          return res.send(`Demo CDN file content for File ID ${fileId}`);
        }
        return;
      } catch (fallbackErr) {
        logger.error({ fallbackErr }, 'Cloud fallback error');
      }

      if (!res.headersSent) {
        return res.status(502).json({ error: 'Bad Gateway: Edge server unreachable' });
      }
    }
  } catch (err) {
    logger.error({ err, fileId }, 'Error in Load Balancer routing handler');
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Internal Server Error in Load Balancer' });
    }
  }
});

module.exports = router;
