const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const db = require('../../shared/db');
const logger = require('../../shared/logger');

const STORAGE_DIR = path.join(__dirname, '../storage');

router.get('/file/:id', async (req, res) => {
  const fileId = req.params.id;

  try {
    const dbResult = await db.query('SELECT * FROM files WHERE id = $1', [fileId]);
    if (dbResult.rows.length === 0) {
      logger.warn({ fileId }, 'Requested file ID not found in database');
      return res.status(404).json({ error: 'File not found' });
    }

    const fileMeta = dbResult.rows[0];
    const storagePath = path.join(STORAGE_DIR, String(fileId));

    if (!fs.existsSync(storagePath)) {
      logger.error({ fileId, storagePath }, 'DB/Disk mismatch: File metadata exists in DB but raw file missing on disk');
      return res.status(404).json({ error: 'File missing from storage' });
    }

    res.setHeader('Content-Type', fileMeta.mime || 'application/octet-stream');
    res.setHeader('Content-Length', fileMeta.size);
    res.setHeader('X-File-Hash', fileMeta.hash);

    const stream = fs.createReadStream(storagePath);
    stream.on('error', (err) => {
      logger.error({ err, fileId }, 'Stream error serving origin file');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream file from storage' });
      }
    });

    stream.pipe(res);
  } catch (err) {
    logger.error({ err, fileId }, 'Error serving origin file');
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
});

module.exports = router;
