const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const authMiddleware = require('../middleware/auth');
const db = require('../../shared/db');
const logger = require('../../shared/logger');

const STORAGE_DIR = path.join(__dirname, '../storage');

router.delete('/file/:id', authMiddleware, async (req, res) => {
  const fileId = req.params.id;

  try {
    const dbResult = await db.query('DELETE FROM files WHERE id = $1 RETURNING *', [fileId]);
    
    const storagePath = path.join(STORAGE_DIR, String(fileId));
    if (fs.existsSync(storagePath)) {
      try {
        await fs.promises.unlink(storagePath);
      } catch (unlinkErr) {
        logger.error({ unlinkErr, storagePath }, 'Error unlinking disk file during delete');
      }
    }

    if (dbResult.rows.length === 0) {
      logger.info({ fileId }, 'Delete target not in DB (idempotent handling)');
      return res.status(200).json({ message: 'File already deleted or does not exist', id: fileId });
    }

    logger.info({ fileId }, 'File deleted successfully from Origin');
    return res.status(200).json({ message: 'File deleted successfully', id: fileId });
  } catch (err) {
    logger.error({ err, fileId }, 'Error deleting file from origin');
    return res.status(500).json({ error: 'Internal Server Error during delete' });
  }
});

module.exports = router;
