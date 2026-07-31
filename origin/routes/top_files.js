const express = require('express');
const db = require('../../shared/db');
const redis = require('../../shared/redis');
const logger = require('../../shared/logger');

const router = express.Router();

// GET /origin/top-files — Returns top 5 files sorted by download count descending
router.get('/top-files', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '100', 10);
    const dbRes = await db.query('SELECT id, filename, download_count, hash, size, mime, created_at FROM files');
    const files = dbRes.rows || [];

    const realTimeRedisCounts = await redis.getAllDownloadCounts();

    const formattedFiles = files.map(file => {
      const redisCount = realTimeRedisCounts[file.id] || 0;
      const dbCount = parseInt(file.download_count || '0', 10);
      const effectiveCount = Math.max(dbCount, redisCount);

      return {
        id: file.id,
        filename: file.filename,
        downloadCount: effectiveCount,
        hash: file.hash,
        size: file.size,
        mime: file.mime,
        createdAt: file.created_at
      };
    });

    formattedFiles.sort((a, b) => b.downloadCount - a.downloadCount);
    const topFiles = formattedFiles.slice(0, limit);

    return res.json({
      limit,
      totalFilesCount: files.length,
      topFiles
    });
  } catch (err) {
    logger.error({ err }, 'Error fetching top files from origin');
    return res.status(500).json({ error: 'Failed to retrieve top files' });
  }
});

module.exports = router;
