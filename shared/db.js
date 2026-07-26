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

const fs = require('fs');
const path = require('path');

const DB_STATE_FILE = path.join(__dirname, '.db_state.json');

let useFallback = false;

function loadDbState() {
  try {
    if (fs.existsSync(DB_STATE_FILE)) {
      const data = fs.readFileSync(DB_STATE_FILE, 'utf8');
      const parsed = JSON.parse(data);
      if (!parsed.request_logs) parsed.request_logs = [];
      return parsed;
    }
  } catch (e) {}
  return { files: [], edges: [], request_logs: [], autoId: 1 };
}

function saveDbState(state) {
  try {
    fs.writeFileSync(DB_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {}
}

pool.on('error', (err) => {
  if (!useFallback) {
    logger.warn({ err: err.message }, 'PostgreSQL connection warning');
  }
});

async function ensureDatabaseExists() {
  const targetDb = process.env.PGDATABASE || 'minicdn';
  const tempPool = new Pool({
    user: process.env.PGUSER || 'postgres',
    host: process.env.PGHOST || 'localhost',
    database: 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    port: parseInt(process.env.PGPORT || '5432', 10),
    connectionTimeoutMillis: 3000
  });

  try {
    const res = await tempPool.query("SELECT 1 FROM pg_database WHERE datname = $1", [targetDb]);
    if (res.rows.length === 0) {
      logger.info(`Database "${targetDb}" does not exist on PostgreSQL server. Auto-creating database...`);
      await tempPool.query(`CREATE DATABASE "${targetDb}"`);
      logger.info(`Database "${targetDb}" created successfully.`);
    }
  } catch (err) {
    // If temp connect fails, log and fall through
  } finally {
    await tempPool.end().catch(() => {});
  }
}

async function initDb() {
  try {
    await ensureDatabaseExists();

    const createFilesTable = `
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
    const createEdgesTable = `
      CREATE TABLE IF NOT EXISTS edges (
        id INT PRIMARY KEY,
        edge_name TEXT NOT NULL,
        status TEXT DEFAULT 'healthy',
        last_seen TIMESTAMP DEFAULT now()
      );
    `;
    const createRequestLogsTable = `
      CREATE TABLE IF NOT EXISTS request_logs (
        id SERIAL PRIMARY KEY,
        file_id INT NOT NULL,
        edge_id INT NOT NULL,
        hit BOOLEAN NOT NULL,
        latency_ms INT NOT NULL,
        created_at TIMESTAMP DEFAULT now()
      );
    `;
    await pool.query(createFilesTable);
    await pool.query(createEdgesTable);
    await pool.query(createRequestLogsTable);
    logger.info('Connected to PostgreSQL successfully. Tables "files", "edges", and "request_logs" verified.');
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

  // Memory Fallback Implementation (Multi-Process IPC synced)
  const sql = text.trim();
  const dbState = loadDbState();

  if (sql.startsWith('CREATE TABLE')) {
    return { rows: [], rowCount: 0 };
  }

  if (sql.includes('INSERT INTO files')) {
    const [filename, hash, size, mime] = params;
    const newRecord = {
      id: dbState.autoId++,
      filename,
      hash,
      size,
      mime,
      download_count: 0,
      created_at: new Date(),
      updated_at: new Date()
    };
    dbState.files.push(newRecord);
    saveDbState(dbState);
    return { rows: [newRecord], rowCount: 1 };
  }

  if (sql.includes('SELECT * FROM files WHERE id = $1')) {
    const fileId = parseInt(params[0], 10);
    const record = dbState.files.find(f => f.id === fileId);
    return { rows: record ? [record] : [], rowCount: record ? 1 : 0 };
  }

  if (sql.includes('DELETE FROM files WHERE id = $1')) {
    const fileId = parseInt(params[0], 10);
    const index = dbState.files.findIndex(f => f.id === fileId);
    if (index !== -1) {
      const removed = dbState.files.splice(index, 1)[0];
      saveDbState(dbState);
      return { rows: [removed], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // Edges Table Queries
  if (sql.includes('INSERT INTO edges') || sql.includes('ON CONFLICT (id)')) {
    const edgeId = parseInt(params[0], 10);
    const edgeName = params[1] || `edge-${edgeId}`;
    const status = params[2] || 'healthy';

    let record = dbState.edges.find(e => e.id === edgeId);
    if (record) {
      record.status = status;
      record.last_seen = new Date();
    } else {
      record = { id: edgeId, edge_name: edgeName, status, last_seen: new Date() };
      dbState.edges.push(record);
    }
    saveDbState(dbState);
    return { rows: [record], rowCount: 1 };
  }

  if (sql.includes('UPDATE edges SET status =')) {
    const status = params[0];
    const edgeId = parseInt(params[1], 10);
    const record = dbState.edges.find(e => e.id === edgeId);
    if (record) {
      record.status = status;
      saveDbState(dbState);
      return { rows: [record], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  if (sql.includes('SELECT * FROM edges WHERE id = $1')) {
    const edgeId = parseInt(params[0], 10);
    const record = dbState.edges.find(e => e.id === edgeId);
    return { rows: record ? [record] : [], rowCount: record ? 1 : 0 };
  }

  if (sql.includes('SELECT * FROM edges')) {
    return { rows: [...dbState.edges], rowCount: dbState.edges.length };
  }

  // Request Logs Table Queries
  if (sql.includes('INSERT INTO request_logs')) {
    const [file_id, edge_id, hit, latency_ms] = params;
    const newLog = {
      id: dbState.autoId++,
      file_id: parseInt(file_id, 10),
      edge_id: parseInt(edge_id, 10),
      hit: Boolean(hit),
      latency_ms: parseInt(latency_ms, 10),
      created_at: new Date()
    };
    dbState.request_logs.push(newLog);
    saveDbState(dbState);
    return { rows: [newLog], rowCount: 1 };
  }

  if (sql.includes('SELECT * FROM request_logs')) {
    return { rows: [...dbState.request_logs], rowCount: dbState.request_logs.length };
  }

  return { rows: [], rowCount: 0 };
}

module.exports = {
  pool,
  query,
  initDb
};
