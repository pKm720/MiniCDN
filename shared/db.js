const { Pool } = require('pg');
require('dotenv').config();
const logger = require('./logger');

const pool = new Pool({
  user: process.env.PGUSER || 'postgres',
  host: process.env.PGHOST || 'localhost',
  database: process.env.PGDATABASE || 'minicdn',
  password: process.env.PGPASSWORD || 'postgres',
  port: parseInt(process.env.PGPORT || '5432', 10),
  connectionTimeoutMillis: 2000
});

let useFallback = false;

// Embedded memory table for graceful fallback when Postgres container is offline
const memoryDb = {
  files: [],
  autoId: 1
};

pool.on('error', (err) => {
  if (!useFallback) {
    logger.warn({ err: err.message }, 'PostgreSQL connection warning');
  }
});

async function initDb() {
  try {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS files (
        id SERIAL PRIMARY KEY,
        filename TEXT NOT NULL,
        hash TEXT NOT NULL,
        size INT NOT NULL,
        mime TEXT,
        download_count INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT now(),
        updated_at TIMESTAMP DEFAULT now()
      );
    `;
    await pool.query(createTableQuery);
    logger.info('Connected to PostgreSQL successfully. Table "files" verified.');
  } catch (err) {
    useFallback = true;
    logger.info({ reason: err.message }, 'PostgreSQL connection unavailable/failed. Falling back to embedded memory database.');
  }
}

async function query(text, params = []) {
  if (!useFallback) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      if (err.code === 'ECONNREFUSED' || err.message.includes('authentication failed')) {
        useFallback = true;
        logger.info('Switching to embedded memory database due to connection error.');
      } else {
        throw err;
      }
    }
  }

  // Memory Fallback Implementation
  const sql = text.trim();

  if (sql.startsWith('CREATE TABLE')) {
    return { rows: [], rowCount: 0 };
  }

  if (sql.includes('INSERT INTO files')) {
    const [filename, hash, size, mime] = params;
    const newRecord = {
      id: memoryDb.autoId++,
      filename,
      hash,
      size,
      mime,
      download_count: 0,
      created_at: new Date(),
      updated_at: new Date()
    };
    memoryDb.files.push(newRecord);
    return { rows: [newRecord], rowCount: 1 };
  }

  if (sql.includes('SELECT * FROM files WHERE id = $1')) {
    const fileId = parseInt(params[0], 10);
    const record = memoryDb.files.find(f => f.id === fileId);
    return { rows: record ? [record] : [], rowCount: record ? 1 : 0 };
  }

  if (sql.includes('DELETE FROM files WHERE id = $1')) {
    const fileId = parseInt(params[0], 10);
    const index = memoryDb.files.findIndex(f => f.id === fileId);
    if (index !== -1) {
      const removed = memoryDb.files.splice(index, 1)[0];
      return { rows: [removed], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  return { rows: [], rowCount: 0 };
}

module.exports = {
  pool,
  query,
  initDb
};
