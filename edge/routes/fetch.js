const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const http = require('http');
const logger = require('../../shared/logger');

function getCacheDir() {
  const edgeId = process.env.EDGE_ID || 1;
  const cacheDir = path.join(__dirname, `../cache/edge_${edgeId}`);
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  return cacheDir;
}

const ORIGIN_HOST = process.env.ORIGIN_HOST || 'localhost';
const ORIGIN_PORT = process.env.PORT_ORIGIN || 4000;

router.get('/file/:id', (req, res) => {
  const startTime = Date.now();
  const fileId = req.params.id;
  const cacheDir = getCacheDir();
  const cachePath = path.join(cacheDir, String(fileId));

  // Step 1: Check Local Cache Hit
  if (fs.existsSync(cachePath)) {
    logger.info({ fileId }, 'Edge Cache HIT');
    const duration = Date.now() - startTime;
    res.setHeader('X-Cache-Status', 'HIT');
    res.setHeader('X-Response-Time-Ms', duration);

    const stream = fs.createReadStream(cachePath);
    stream.on('error', (err) => {
      logger.error({ err, fileId }, 'Error streaming file from edge cache');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Cache read error' });
      }
    });
    return stream.pipe(res);
  }

  // Step 2: Cache Miss — Call Origin Server
  logger.info({ fileId }, 'Edge Cache MISS — fetching from Origin');

  const originUrl = `http://${ORIGIN_HOST}:${ORIGIN_PORT}/origin/file/${fileId}`;

  const originReq = http.get(originUrl, (originRes) => {
    if (originRes.statusCode === 404) {
      logger.warn({ fileId }, 'Origin returned 404 for file');
      const duration = Date.now() - startTime;
      res.setHeader('X-Cache-Status', 'MISS');
      res.setHeader('X-Response-Time-Ms', duration);
      return res.status(404).json({ error: 'File not found on origin' });
    }

    if (originRes.statusCode !== 200) {
      logger.error({ fileId, statusCode: originRes.statusCode }, 'Origin returned error status');
      const duration = Date.now() - startTime;
      res.setHeader('X-Cache-Status', 'MISS');
      res.setHeader('X-Response-Time-Ms', duration);
      return res.status(502).json({ error: 'Origin returned non-200 status code', statusCode: originRes.statusCode });
    }

    // Set response headers
    const duration = Date.now() - startTime;
    res.setHeader('X-Cache-Status', 'MISS');
    res.setHeader('X-Response-Time-Ms', duration);
    if (originRes.headers['content-type']) {
      res.setHeader('Content-Type', originRes.headers['content-type']);
    }
    if (originRes.headers['content-length']) {
      res.setHeader('Content-Length', originRes.headers['content-length']);
    }

    // Stream to temporary file to avoid incomplete cache entries on crash/error
    const tempCachePath = path.join(cacheDir, `${fileId}.tmp`);
    const fileWriteStream = fs.createWriteStream(tempCachePath);

    originRes.pipe(fileWriteStream);
    originRes.pipe(res);

    fileWriteStream.on('finish', () => {
      fs.rename(tempCachePath, cachePath, (err) => {
        if (err) {
          logger.error({ err, fileId }, 'Failed to move temp cache file to cache path');
        } else {
          logger.info({ fileId }, 'File cached successfully on Edge');
        }
      });
    });

    fileWriteStream.on('error', (err) => {
      logger.error({ err, fileId }, 'Error writing to temp cache file on Edge');
      if (fs.existsSync(tempCachePath)) {
        fs.unlink(tempCachePath, () => { });
      }
    });
  });

  originReq.on('error', (err) => {
    logger.error({ err: err.message, fileId }, 'Origin server unreachable from Edge');
    const duration = Date.now() - startTime;
    if (!res.headersSent) {
      res.setHeader('X-Cache-Status', 'MISS');
      res.setHeader('X-Response-Time-Ms', duration);
      res.status(502).json({ error: 'Bad Gateway: Origin server unreachable' });
    }
  });

  // Set 5s timeout on origin request
  originReq.setTimeout(5000, () => {
    originReq.destroy();
    logger.error({ fileId }, 'Origin request timed out from Edge');
    const duration = Date.now() - startTime;
    if (!res.headersSent) {
      res.setHeader('X-Cache-Status', 'MISS');
      res.setHeader('X-Response-Time-Ms', duration);
      res.status(504).json({ error: 'Gateway Timeout: Origin request timed out' });
    }
  });
});

module.exports = router;
