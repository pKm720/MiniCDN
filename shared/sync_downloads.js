const redis = require('./redis');
const db = require('./db');
const logger = require('./logger');

let syncInterval = null;

async function syncDownloadCounts() {
  try {
    const counts = await redis.getAllDownloadCounts();
    const fileIds = Object.keys(counts);

    if (fileIds.length === 0) return;

    let syncedCount = 0;
    for (const fileId of fileIds) {
      const downloadCount = counts[fileId];
      const numericId = parseInt(fileId, 10);
      if (!isNaN(numericId) && downloadCount !== undefined) {
        await db.query(
          'UPDATE files SET download_count = $1, updated_at = NOW() WHERE id = $2',
          [downloadCount, numericId]
        );
        syncedCount++;
      }
    }

    if (syncedCount > 0) {
      logger.info({ syncedCount }, 'Periodic sync: Download counters mirrored from Redis to PostgreSQL files table');
    }
  } catch (err) {
    logger.error({ err }, 'Error syncing download counters to database');
  }
}

function startDownloadSync(intervalMs = 30000) {
  if (syncInterval) return;
  logger.info(`Starting background Download Counter Sync worker (interval: ${intervalMs}ms)`);
  syncInterval = setInterval(syncDownloadCounts, intervalMs);
}

function stopDownloadSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

module.exports = {
  syncDownloadCounts,
  startDownloadSync,
  stopDownloadSync
};
