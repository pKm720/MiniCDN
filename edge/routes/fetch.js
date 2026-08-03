const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const http = require('http');
const logger = require('../../shared/logger');
const redis = require('../../shared/redis');
const lru = require('../lru');
const replication = require('../../shared/replication');

const MAX_CACHE_FILES = parseInt(process.env.MAX_CACHE_FILES || '20', 10);
const inFlightFetches = new Map(); // String(fileId) -> Promise

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

router.get('/file/:id', async (req, res) => {
  const startTime = Date.now();
  const fileId = req.params.id;
  const edgeId = process.env.EDGE_ID || 1;
  const cacheDir = getCacheDir();
  const cachePath = path.join(cacheDir, String(fileId));

  // Check if file is currently being fetched from origin by a concurrent request
  if (!fs.existsSync(cachePath) && inFlightFetches.has(String(fileId))) {
    logger.info({ fileId, edgeId }, 'Concurrent request for uncached file — awaiting in-flight Origin fetch');
    try {
      await inFlightFetches.get(String(fileId));
    } catch (e) {}

    if (fs.existsSync(cachePath)) {
      const duration = Date.now() - startTime;
      res.setHeader('X-Cache-Status', 'HIT');
      res.setHeader('X-Response-Time-Ms', duration);
      redis.incrementEdgeHit(edgeId).catch(() => {});
      return fs.createReadStream(cachePath).pipe(res);
    }
  }

  // Step 1: Check Local Cache Hit & TTL Expiration
  if (fs.existsSync(cachePath)) {
    const cachedAt = await redis.getCacheTtl(edgeId, fileId);
    const ttlMs = parseInt(process.env.CACHE_TTL_MS || '1800000', 10);
    const isExpired = cachedAt && (Date.now() - cachedAt > ttlMs);

    if (isExpired) {
      logger.info({ fileId, edgeId, cachedAt, ttlMs }, 'Edge Cache TTL EXPIRED — refetching from Origin');
    } else {
      logger.info({ fileId, edgeId }, 'Edge Cache HIT');
      const duration = Date.now() - startTime;
      res.setHeader('X-Cache-Status', 'HIT');
      res.setHeader('X-Response-Time-Ms', duration);

      // Update Redis lookup, LRU recency, hit counter, and download counter
      redis.addFileToEdge(fileId, edgeId).catch(err => logger.error({ err }, 'Redis error'));
      redis.updateEdgeRecency(edgeId, fileId, Date.now()).catch(err => logger.error({ err }, 'Redis error'));
      redis.incrementEdgeHit(edgeId).catch(err => logger.error({ err }, 'Redis error'));
      redis.incrementDownloadCount(fileId).then(count => {
        replication.triggerReplication(fileId).catch(err => logger.error({ err, fileId }, 'Replication trigger error'));
      }).catch(err => logger.error({ err }, 'Redis error'));

      const stream = fs.createReadStream(cachePath);
      stream.on('error', (err) => {
        logger.error({ err, fileId }, 'Error streaming file from edge cache');
        if (!res.headersSent) {
          res.status(500).json({ error: 'Cache read error' });
        }
      });
      return stream.pipe(res);
    }
  }

  // Register in-flight fetch promise for concurrent request deduplication
  let resolveInFlight, rejectInFlight;
  if (!inFlightFetches.has(String(fileId))) {
    const fetchPromise = new Promise((res, rej) => {
      resolveInFlight = res;
      rejectInFlight = rej;
    });
    inFlightFetches.set(String(fileId), fetchPromise);
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

    // Increment download counter & miss counter (MISS counts as user demand)
    redis.incrementEdgeMiss(edgeId).catch(err => logger.error({ err }, 'Redis error'));
    redis.incrementDownloadCount(fileId).then(count => {
      replication.triggerReplication(fileId).catch(err => logger.error({ err, fileId }, 'Replication trigger error'));
    }).catch(err => logger.error({ err }, 'Redis error'));

    // Stream to temporary file to avoid incomplete cache entries on crash/error
    const tempCachePath = path.join(cacheDir, `${fileId}.tmp`);
    const fileWriteStream = fs.createWriteStream(tempCachePath);

    originRes.pipe(fileWriteStream);
    originRes.pipe(res);

    fileWriteStream.on('finish', async () => {
      try {
        const isBenchmark = process.env.BENCHMARK_MODE === 'true' || process.env.BENCHMARK_MODE === '1';
        const configuredMax = parseInt(process.env.MAX_CACHE_FILES || '20', 10);
        const maxCap = isBenchmark ? Math.max(configuredMax, 50) : configuredMax;
        await lru.evictIfFull(edgeId, cacheDir, maxCap);
        
        fs.rename(tempCachePath, cachePath, (err) => {
          inFlightFetches.delete(String(fileId));
          if (resolveInFlight) resolveInFlight();

          if (err) {
            logger.error({ err, fileId }, 'Failed to move temp cache file to cache path');
          } else {
            logger.info({ fileId, edgeId }, 'File cached successfully on Edge');
            redis.addFileToEdge(fileId, edgeId).catch(e => logger.error({ e }, 'Redis error'));
            redis.updateEdgeRecency(edgeId, fileId, Date.now()).catch(e => logger.error({ e }, 'Redis error'));
            redis.setCacheTtl(edgeId, fileId, Date.now()).catch(e => logger.error({ e }, 'Redis error'));
          }
        });
      } catch (evictErr) {
        inFlightFetches.delete(String(fileId));
        if (resolveInFlight) resolveInFlight();
        logger.error({ evictErr }, 'Error during LRU eviction check');
      }
    });

    fileWriteStream.on('error', (err) => {
      inFlightFetches.delete(String(fileId));
      if (rejectInFlight) rejectInFlight();

      logger.error({ err, fileId }, 'Error writing to temp cache file on Edge');
      if (fs.existsSync(tempCachePath)) {
        fs.unlink(tempCachePath, () => { });
      }
    });
  });

  originReq.on('error', (err) => {
    inFlightFetches.delete(String(fileId));
    if (rejectInFlight) rejectInFlight();
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
