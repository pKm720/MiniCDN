const express = require('express');
require('dotenv').config();
const logger = require('../shared/logger');
const fetchRoutes = require('./routes/fetch');

const app = express();
const EDGE_ID = process.env.EDGE_ID || 1;
const PORT = process.env.PORT_EDGE || (3000 + parseInt(EDGE_ID, 10));

app.use(express.json());

app.use('/edge', fetchRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'edge', edgeId: EDGE_ID, port: PORT });
});

async function startServer() {
  app.listen(PORT, () => {
    logger.info(`Edge Server ${EDGE_ID} running on port ${PORT}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = app;
