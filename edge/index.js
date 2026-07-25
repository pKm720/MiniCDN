const express = require('express');
require('dotenv').config();
const logger = require('../shared/logger');
const fetchRoutes = require('./routes/fetch');

const app = express();
const PORT = process.env.PORT_EDGE || 3001;

app.use(express.json());

app.use('/edge', fetchRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'edge', edgeId: process.env.EDGE_ID || 1 });
});

async function startServer() {
  app.listen(PORT, () => {
    logger.info(`Edge Server running on port ${PORT}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = app;
