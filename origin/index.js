const express = require('express');
require('dotenv').config();
const logger = require('../shared/logger');
const db = require('../shared/db');
const syncDownloads = require('../shared/sync_downloads');

const uploadRoutes = require('./routes/upload');
const serveRoutes = require('./routes/serve');
const deleteRoutes = require('./routes/delete');
const topFilesRoutes = require('./routes/top_files');

const app = express();
const PORT = process.env.PORT_ORIGIN || 4000;

app.use(express.json());

// Enable CORS for browser access
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-file-id');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use('/origin', uploadRoutes);
app.use('/origin', serveRoutes);
app.use('/origin', deleteRoutes);
app.use('/origin', topFilesRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'origin' });
});

async function startServer() {
  try {
    await db.initDb();
    syncDownloads.startDownloadSync(parseInt(process.env.DOWNLOAD_SYNC_INTERVAL_MS || '30000', 10));
    app.listen(PORT, () => {
      logger.info(`Origin Server running on port ${PORT}`);
    });
  } catch (err) {
    logger.error({ err }, 'Failed to start Origin Server');
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = app;
