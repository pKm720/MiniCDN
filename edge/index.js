const express = require('express');
const http = require('http');
require('dotenv').config();
const logger = require('../shared/logger');
const fetchRoutes = require('./routes/fetch');
const receiveRoutes = require('./routes/receive');
const statsRoutes = require('./routes/stats');

const app = express();
const EDGE_ID = parseInt(process.env.EDGE_ID || '1', 10);
const PORT = process.env.PORT_EDGE || (3000 + EDGE_ID);
const LB_HOST = process.env.LB_HOST || 'localhost';
const PORT_LB = process.env.PORT_LB || 3000;
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '10000', 10);

app.use(express.json());

app.use('/edge', fetchRoutes);
app.use('/edge', receiveRoutes);
app.use('/edge', statsRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'edge', edgeId: EDGE_ID, port: PORT });
});

function sendHeartbeat() {
  const payload = JSON.stringify({ edgeId: EDGE_ID });
  const req = http.request({
    hostname: LB_HOST,
    port: PORT_LB,
    path: '/lb/heartbeat',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    },
    timeout: 3000
  }, (res) => {
    if (res.statusCode === 200) {
      logger.info({ edgeId: EDGE_ID }, 'Heartbeat sent successfully to Load Balancer');
    } else {
      logger.warn({ edgeId: EDGE_ID, statusCode: res.statusCode }, 'Heartbeat returned non-200 status');
    }
  });

  req.on('error', (err) => {
    logger.warn({ edgeId: EDGE_ID, err: err.message }, 'Failed to send heartbeat to Load Balancer (LB offline/unreachable)');
  });

  req.write(payload);
  req.end();
}

function startHeartbeatLoop() {
  sendHeartbeat(); // send initial heartbeat on boot
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
}

async function startServer() {
  app.listen(PORT, () => {
    logger.info(`Edge Server ${EDGE_ID} running on port ${PORT}`);
    startHeartbeatLoop();
  });
}

if (require.main === module) {
  startServer();
}

module.exports = app;
