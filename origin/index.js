const express = require('express');
require('dotenv').config();
const logger = require('../shared/logger');
const db = require('../shared/db');
const syncDownloads = require('../shared/sync_downloads');

const uploadRoutes = require('./routes/upload');
const serveRoutes = require('./routes/serve');
const deleteRoutes = require('./routes/delete');

const app = express();
const PORT = process.env.PORT_ORIGIN || 4000;

app.use(express.json());

app.use('/origin', uploadRoutes);
app.use('/origin', serveRoutes);
app.use('/origin', deleteRoutes);

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
