const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const authMiddleware = require('../middleware/auth');
const db = require('../../shared/db');
const logger = require('../../shared/logger');

const STORAGE_DIR = path.join(__dirname, '../storage');
const TEMP_DIR = path.join(__dirname, '../temp');
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Stream uploads directly to disk in a temp location to prevent memory pressure
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TEMP_DIR),
    filename: (req, file, cb) => cb(null, `upload-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`)
  })
});

router.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Bad Request: No file uploaded' });
    }

    const tempPath = req.file.path;

    // Compute SHA-256 via streaming read from disk
    const computedHash = await new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(tempPath);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', err => reject(err));
    });

    // Check declared hash if provided by client (header or form field)
    const declaredHash = req.headers['x-file-hash'] || req.body.hash;
    if (declaredHash && declaredHash.toLowerCase() !== computedHash.toLowerCase()) {
      try { await fs.promises.unlink(tempPath); } catch (e) {}
      logger.warn({ declaredHash, computedHash }, 'Hash mismatch during file upload');
      return res.status(400).json({
        error: 'Bad Request: Declared hash does not match computed SHA-256 checksum',
        computedHash,
        declaredHash
      });
    }

    const size = req.file.size;
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
    try {
      await fs.promises.rename(tempPath, storagePathId);
    } catch (renameErr) {
      await fs.promises.copyFile(tempPath, storagePathId);
      await fs.promises.unlink(tempPath);
    }
    try { await fs.promises.copyFile(storagePathId, storagePathName); } catch (e) {}

    logger.info({ fileId, filename, size, hash: computedHash }, 'File uploaded successfully');

    return res.status(201).json({
      id: fileId,
      filename,
      size,
      hash: computedHash,
      mime
    });
  } catch (err) {
    if (req.file && req.file.path) {
      try { await fs.promises.unlink(req.file.path); } catch (e) {}
    }
    logger.error({ err }, 'Error handling file upload');
    return res.status(500).json({ error: 'Internal Server Error during upload' });
  }
});

module.exports = router;
