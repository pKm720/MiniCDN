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
const PORT = process.env.PORT_LB || 3000;

app.use(express.json());

// Enable CORS for browser access
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-file-id');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Serve dashboard static assets
app.use('/dashboard', express.static(path.join(__dirname, '../dashboard')));
app.use('/cdn-dashboard', express.static(path.join(__dirname, '../../CDN_FrontEnd')));

app.use('/lb', heartbeatRoutes);
app.use('/lb', statsRoutes);
app.use('/lb', lbRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'load-balancer', port: PORT });
});

async function startServer() {
  try {
    await db.initDb();
    healthMonitor.startHealthMonitor(parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '10000', 10));
    app.listen(PORT, () => {
      logger.info(`Load Balancer running on port ${PORT}`);
    });
  } catch (err) {
    logger.error({ err }, 'Failed to start Load Balancer');
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = app;
