const express = require('express');
const router = express.Router();
const redis = require('../../shared/redis');
const db = require('../../shared/db');
const logger = require('../../shared/logger');

router.post('/heartbeat', async (req, res) => {
  try {
    const { edgeId } = req.body;
    if (!edgeId) {
      return res.status(400).json({ error: 'Bad Request: Missing edgeId' });
    }

    const numericEdgeId = parseInt(edgeId, 10);
    const now = Date.now();

    // 1. Update Redis key: edge:{id}:heartbeat -> timestamp
    await redis.setHeartbeat(numericEdgeId, now);

    // 2. Update Postgres edges table: status = 'healthy', last_seen = NOW()
    const queryText = `
      INSERT INTO edges (id, edge_name, status, last_seen)
      VALUES ($1, $2, 'healthy', NOW())
      ON CONFLICT (id) DO UPDATE SET status = 'healthy', last_seen = NOW()
    `;
    await db.query(queryText, [numericEdgeId, `edge-${numericEdgeId}`]);

    logger.info({ edgeId: numericEdgeId }, 'Heartbeat received from Edge node');

    return res.json({ status: 'ok', edgeId: numericEdgeId, healthy: true, timestamp: now });
  } catch (err) {
    logger.error({ err }, 'Error processing edge heartbeat');
    return res.status(500).json({ error: 'Internal Server Error processing heartbeat' });
  }
});

module.exports = router;
