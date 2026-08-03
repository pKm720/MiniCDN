const express = require('express');
require('dotenv').config();
const logger = require('../shared/logger');
const db = require('../shared/db');
const heartbeatRoutes = require('./routes/heartbeat');
const lbRouter = require('./routes/router');
const statsRoutes = require('./routes/stats');
const healthMonitor = require('./health_monitor');

const path = require('path');

const app = express();
const PORT = process.env.PORT || process.env.PORT_LB || 3000;

app.use(express.json());

// Enable CORS for browser access
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-file-id, x-force-edge-id');
  res.setHeader('Access-Control-Expose-Headers', 'X-Routed-Edge-Id, X-Cache-Status, X-Response-Time-MS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Serve dashboard static assets
app.use('/dashboard', express.static(path.join(__dirname, '../dashboard')));
app.use('/cdn-dashboard', express.static(path.join(__dirname, '../../CDN_FrontEnd')));

const originUpload = require('../origin/routes/upload');
const topFiles = require('../origin/routes/top_files');

app.use('/lb', heartbeatRoutes);
app.use('/lb', statsRoutes);
app.use('/origin', originUpload);
app.use('/origin', topFiles);
app.use('/lb', lbRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'load-balancer', port: PORT });
});

const redis = require('../shared/redis');

async function startServer() {
  try {
    await redis.initRedis().catch(() => {});
    await db.initDb().catch(err => logger.warn({ err: err.message || err }, 'DB init warning - using memory fallback'));
    healthMonitor.startHealthMonitor(parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '10000', 10));
    app.listen(PORT, '0.0.0.0', () => {
      logger.info(`Load Balancer running on port ${PORT} (0.0.0.0)`);
    });
  } catch (err) {
    logger.error({ err: err.message || err }, 'Failed to start Load Balancer in primary mode');
    app.listen(PORT, '0.0.0.0', () => {
      logger.info(`Load Balancer running on port ${PORT} in fallback mode`);
    });
  }
}

if (require.main === module) {
  startServer();
}

module.exports = app;
