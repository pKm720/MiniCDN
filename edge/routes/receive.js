const express = require('express');
const fs = require('fs');
const path = require('path');
const logger = require('../../shared/logger');
const redis = require('../../shared/redis');
const lru = require('../cache/lru');

const router = express.Router();
const EDGE_ID = parseInt(process.env.EDGE_ID || '1', 10);
const CACHE_DIR = path.join(__dirname, `../cache/edge_${EDGE_ID}`);

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// POST /edge/receive — Receive proactive file push from Origin
router.post('/receive', async (req, res) => {
  const fileId = req.headers['x-file-id'] || req.query.fileId;
  if (!fileId) {
    return res.status(400).json({ error: 'Missing x-file-id header' });
  }

  const cachePath = path.join(CACHE_DIR, String(fileId));
  const tempPath = path.join(CACHE_DIR, `${fileId}.push.tmp`);
  const writeStream = fs.createWriteStream(tempPath);

  logger.info({ fileId, edgeId: EDGE_ID }, 'Edge receiving proactive replication push from Origin');

  req.pipe(writeStream);

  writeStream.on('finish', async () => {
    try {
      const maxCap = parseInt(process.env.MAX_CACHE_FILES || '20', 10);
      await lru.evictIfFull(EDGE_ID, CACHE_DIR, maxCap);

      fs.rename(tempPath, cachePath, async (err) => {
        if (err) {
          logger.error({ err, fileId, edgeId: EDGE_ID }, 'Failed to save pushed file to edge cache');
          return res.status(500).json({ error: 'Cache write failed' });
        }

        const now = Date.now();
        await redis.addFileToEdge(fileId, EDGE_ID);
        await redis.updateEdgeRecency(EDGE_ID, fileId, now);
        await redis.setCacheTtl(EDGE_ID, fileId, now);

        logger.info({ fileId, edgeId: EDGE_ID }, 'Proactive replication push cached successfully on Edge');
        return res.json({ success: true, edgeId: EDGE_ID, fileId: String(fileId) });
      });
    } catch (e) {
      logger.error({ e, fileId }, 'Error finalizing proactive replication push');
      return res.status(500).json({ error: 'Replication processing failed' });
    }
  });

  writeStream.on('error', (err) => {
    logger.error({ err, fileId }, 'Error writing proactive replication push to disk');
    return res.status(500).json({ error: 'Stream write error' });
  });
});

module.exports = router;
