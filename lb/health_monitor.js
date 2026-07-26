const redis = require('../shared/redis');
const db = require('../shared/db');
const logger = require('../shared/logger');

const MISSED_THRESHOLD_MS = parseInt(process.env.MISSED_HEARTBEAT_THRESHOLD_MS || '25000', 10);
let monitorInterval = null;

async function checkEdgeHealth() {
  try {
    // Fetch all registered edges from database
    const dbResult = await db.query('SELECT * FROM edges');
    const edges = dbResult.rows || [];
    const now = Date.now();

    for (const edge of edges) {
      const edgeId = edge.id;
      const hbTimestamp = await redis.getHeartbeat(edgeId);

      let lastSeenMs = 0;
      if (hbTimestamp) {
        lastSeenMs = parseInt(hbTimestamp, 10);
      } else if (edge.last_seen) {
        lastSeenMs = new Date(edge.last_seen).getTime();
      }

      const elapsed = now - lastSeenMs;

      // If last heartbeat is older than threshold (missed 2+ beats) and currently marked healthy:
      if (elapsed > MISSED_THRESHOLD_MS && edge.status === 'healthy') {
        logger.warn({ edgeId, elapsedMs: elapsed }, `Edge ${edgeId} marked OFFLINE (missed 2+ heartbeats)`);
        await db.query("UPDATE edges SET status = $1 WHERE id = $2", ['offline', edgeId]);
      }
      // If heartbeat resumed and currently marked offline:
      else if (elapsed <= MISSED_THRESHOLD_MS && edge.status === 'offline') {
        logger.info({ edgeId, elapsedMs: elapsed }, `Edge ${edgeId} restored to HEALTHY (heartbeat resumed)`);
        await db.query("UPDATE edges SET status = $1 WHERE id = $2", ['healthy', edgeId]);
      }
    }
  } catch (err) {
    logger.error({ err }, 'Error during edge health monitoring check');
  }
}

function startHealthMonitor(intervalMs = 10000) {
  if (monitorInterval) return;
  logger.info(`Starting background Health Monitor (interval: ${intervalMs}ms, offline threshold: ${MISSED_THRESHOLD_MS}ms)`);
  monitorInterval = setInterval(checkEdgeHealth, intervalMs);
}

function stopHealthMonitor() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

module.exports = {
  checkEdgeHealth,
  startHealthMonitor,
  stopHealthMonitor
};
