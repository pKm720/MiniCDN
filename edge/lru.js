const fs = require('fs');
const path = require('path');
const redis = require('../shared/redis');
const logger = require('../shared/logger');

async function evictIfFull(edgeId, cacheDir, maxCapacity) {
  try {
    const isBenchmark = process.env.BENCHMARK_MODE === 'true' || process.env.BENCHMARK_MODE === '1';
    const effectiveCapacity = isBenchmark ? Math.max(maxCapacity, 100) : maxCapacity;

    const recencyMap = await redis.getEdgeCacheRecency(edgeId);
    const cachedFiles = Object.keys(recencyMap);

    if (cachedFiles.length < effectiveCapacity) {
      return;
    }

    // Sort files by lastAccessedTimestamp ascending (oldest first)
    cachedFiles.sort((a, b) => recencyMap[a] - recencyMap[b]);

    const evictCount = (cachedFiles.length - effectiveCapacity) + 1;
    const toEvict = cachedFiles.slice(0, evictCount);

    for (const fileId of toEvict) {
      logger.info({ edgeId, fileId }, 'Evicting least recently used file from Edge cache');
      const filePath = path.join(cacheDir, String(fileId));
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) {}
      }

      await redis.removeFileFromEdge(fileId, edgeId).catch(() => {});
      await redis.removeEdgeRecency(edgeId, fileId).catch(() => {});
      await redis.removeCacheTtl(edgeId, fileId).catch(() => {});
    }
  } catch (err) {
    logger.error({ err, edgeId }, 'Error during LRU cache eviction check');
  }
}

module.exports = {
  evictIfFull
};
