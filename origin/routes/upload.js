const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const authMiddleware = require('../middleware/auth');
const db = require('../../shared/db');
const logger = require('../../shared/logger');

// Store temporarily in memory or temp file to check SHA-256 integrity first
const upload = multer({ storage: multer.memoryStorage() });

const STORAGE_DIR = path.join(__dirname, '../storage');
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

router.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Bad Request: No file uploaded' });
    }

    const fileBuffer = req.file.buffer;
    const computedHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // Check declared hash if provided by client (header or form field)
    const declaredHash = req.headers['x-file-hash'] || req.body.hash;
    if (declaredHash && declaredHash.toLowerCase() !== computedHash.toLowerCase()) {
      logger.warn({ declaredHash, computedHash }, 'Hash mismatch during file upload');
      return res.status(400).json({
        error: 'Bad Request: Declared hash does not match computed SHA-256 checksum',
        computedHash,
        declaredHash
      });
    }

    const size = fileBuffer.length;
    const filename = req.file.originalname || 'unnamed_file';
    const mime = req.file.mimetype || 'application/octet-stream';

    // Insert DB row first to obtain auto-increment ID
    const insertResult = await db.query(
      'INSERT INTO files (filename, hash, size, mime) VALUES ($1, $2, $3, $4) RETURNING id',
      [filename, computedHash, size, mime]
    );

    const fileId = insertResult.rows[0].id;

    if (!fs.existsSync(STORAGE_DIR)) {
      fs.mkdirSync(STORAGE_DIR, { recursive: true });
    }

    // Write file to origin/storage/{id} and origin/storage/{filename}
    const storagePathId = path.join(STORAGE_DIR, String(fileId));
    const storagePathName = path.join(STORAGE_DIR, filename);
    await fs.promises.writeFile(storagePathId, fileBuffer);
    try { await fs.promises.writeFile(storagePathName, fileBuffer); } catch (e) {}

    logger.info({ fileId, filename, size, hash: computedHash }, 'File uploaded successfully');

    return res.status(201).json({
      id: fileId,
      filename,
      size,
      hash: computedHash,
      mime
    });
  } catch (err) {
    logger.error({ err }, 'Error handling file upload');
    return res.status(500).json({ error: 'Internal Server Error during upload' });
  }
});

module.exports = router;
